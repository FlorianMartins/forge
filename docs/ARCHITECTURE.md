# Architecture

Ce document explique **pourquoi** le code est découpé ainsi. Le découpage lui-même se lit dans
l'arborescence ; ce qui ne s'y lit pas, ce sont les contraintes qui l'ont produit.

## La règle qui structure tout : `src/core/` ignore l'éditeur

Aucun fichier de `src/core/` n'importe `vscode`. Ce n'est pas une élégance, c'est ce qui rend trois
choses possibles :

1. **Tester le comportement sans éditeur.** Le budget, l'anonymisation, la boucle d'agent, le cache
   de complétion et la dérivation du prompt sont testés en millisecondes avec `node:test`. Un test
   qui a besoin de lancer VS Code n'est pas écrit, et un comportement non testé finit par dériver.
2. **Faire tourner le même produit dans un terminal.** `forge` (`src/cli/`) réutilise le noyau tel
   quel. C'est aussi la vérification honnête du découpage : si une règle ne marche que dans la barre
   latérale, c'est qu'elle était au mauvais endroit.
3. **Auditer une surface réduite.** Une équipe sécurité qui veut savoir ce qui sort lit
   `core/redaction/` et `extension/egress.ts`, pas 4 000 lignes d'interface.

```
                      ┌───────────────────────┐
   VS Code  ─────────►│  src/extension/       │─┐
                      │  barre latérale,      │ │
                      │  complétion, commandes│ │
                      └───────────────────────┘ │     ┌──────────────────┐
                                                ├────►│    src/core/     │────► HTTP
                      ┌───────────────────────┐ │     │ (aucun `vscode`) │
   Terminal ─────────►│  src/cli/             │─┘     └──────────────────┘
                      └───────────────────────┘
```

## Les cinq idées

### 1. Le transcript n'est pas le prompt

`core/session/session.ts`. La conversation est un journal que l'utilisateur possède ; ce que le
modèle voit en est **dérivé** à chaque tour. D'où trois actions qui n'existent pas ailleurs :

- **muet** — l'échange reste à l'écran, sort du prompt ;
- **supprimer** — il quitte le journal ;
- **épingler** — il survit à la coupe quand le budget de contexte est atteint.

Conséquence directe : une mauvaise réponse cesse d'empoisonner les dix suivantes *et* d'être
refacturée à chaque tour. Ce qui a été coupé faute de place est **rapporté**, jamais oublié en
silence.

### 2. Un seul endroit où des messages deviennent une requête

`core/agent/loop.ts` appelle `beforeRequest` juste avant chaque appel réseau, et rien d'autre ne
construit de requête. C'est ce qui permet d'affirmer « visible par le modèle ⇒ anonymisé » par
construction plutôt que par vigilance. La boucle, elle, ignore :

- **ce que fait un outil** (les outils sont injectés — l'éditeur en donne sept, le terminal six) ;
- **ce qui est permis** (l'approbation est un rappel : la boucle demande, elle ne décide pas) ;
- **ce qui peut sortir** (l'anonymisation est un rappel).

Un outil refusé ou en échec renvoie un **résultat** au modèle. Un appel sans résultat est une erreur
de protocole chez la plupart des fournisseurs et un blocage silencieux chez les autres.

### 3. Le mode décide de l'outillage, pas le prompt

`core/session/modes.ts`. Trois modes, et la différence entre eux est ce que l'assistant **peut**
faire, pas à quel point il est malin : `chat` n'a aucun outil, `plan` n'a que les outils qui
observent (liste blanche explicite : un outil neuf est sans pouvoir tant qu'il n'y est pas nommé),
`agent` a tout. Un modèle en mode Plan qui déciderait d'écrire un fichier ne trouve aucun outil pour
le faire. Le prompt ne fait que décrire le mode dans lequel il est déjà.

Les permissions (`core/agent/permissions.ts`) sont la deuxième moitié : elles portent sur la
**forme** de l'action, jamais sur une occurrence. Autoriser `npm test` n'autorise pas `npm publish`,
et un refus l'emporte toujours sur une autorisation.

### 4. Local d'abord, escalade consentie

`core/router/route.ts`. La complétion, les embeddings et les corvées (titres, messages de commit)
**ne s'escaladent jamais** : c'est le trafic fréquent, et c'est exactement ce qu'un modèle 7 B fait
bien. Une question de discussion s'escalade sur un signal explicite (contexte plus grand que la
fenêtre locale, ou classe de question que les petits modèles ratent) et selon une politique :
`never`, `ask` (défaut), `auto`. **Le routeur ne dépense jamais de lui-même.**

### 5. Une carte, pas le territoire

`core/context/repomap.ts`. Les symboles de tête sont extraits par expressions régulières et non par
un parseur. L'objection est juste — un regex n'est pas un parseur — et le compromis est assumé :
tree-sitter coûte un binaire natif par plateforme ou un WASM, pour une carte dont le rôle est de
dire « il existe une fonction `parseInvoice` dans `billing/parse.ts` ». Dans VS Code, quand un
serveur de langage a déjà ouvert le fichier, ses symboles sont préférés.

Le classement met en tête le fichier édité, ses voisins de dossier, ce qu'il importe et ce qui
l'importe, puis les fichiers ouverts et récemment modifiés.

### 6. Zéro dépendance à l'exécution

Le SSE, le glob, le diff, l'estimation de jetons, le rendu Markdown du panneau : écrits à la main.
Un assistant censé protéger une entreprise de la fuite de son code ne peut pas lui demander de faire
confiance à un arbre de dépendances transitives. Les quatre paquets présents (`typescript`,
`esbuild`, `@types/*`) ne sortent jamais du poste de développement, et le `.vsix` publié ne contient
que du code de ce dépôt.

## Le trajet d'une requête distante

```
question  ─►  session.build()      transcript → messages (muets exclus, coupe rapportée)
          ─►  route()              quel modèle, et faut-il demander une escalade
          ─►  gate.prepare()       ① globs interdits  ② anonymisation  ③ refus  ④ consentement
          ─►  budget.check()       estimation avant l'appel
          ─►  runTurn()            appel, outils, ré-anonymisation à chaque étape
          ─►  vault.restore()      les marqueurs redeviennent les vraies valeurs, chez vous
          ─►  budget.record()      coût réel (fourni par OpenRouter, estimé sinon)
          ─►  gate.record()        journal : métadonnées, jamais de contenu
```

## Ce qui est délibérément absent

- **Pas d'index vectoriel.** Il faudrait soit calculer des embeddings sur le poste (lent, faux dès
  qu'on change de branche), soit envoyer le code à une API d'embeddings — exactement ce que
  l'extension existe pour éviter. La carte du dépôt plus une recherche ciblée couvrent le besoin.
- **Pas de participant `chat` natif VS Code.** L'API dépendait de l'extension Copilot ; un panneau
  webview donne le contrôle total sur ce qui est affiché et ce qui est envoyé.
- **Pas de police d'icônes.** Le panneau dessine ses icônes en SVG inline. La première version
  utilisait des glyphes Unicode et la moitié s'affichait en carrés vides dans la police d'interface
  de l'éditeur.
- **Pas de télémétrie.** Aucune, même anonyme, même optionnelle. Le seul compteur est local :
  suggestions demandées / acceptées, dans l'infobulle de la barre d'état.
