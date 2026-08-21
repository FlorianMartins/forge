# Hivey Forge

**Un assistant de code pour VS Code qui ne fait pas sortir votre code.**
Modèles locaux (Ollama, LM Studio, vLLM, llama.cpp) ou passerelle distante (OpenRouter, Azure,
LiteLLM, Anthropic) — au choix, par rôle, et **anonymisé quand ça sort**.

Open source (Apache-2.0), **zéro dépendance à l'exécution**, **zéro télémétrie**.

![La barre latérale de Hivey Forge dans VS Code](docs/images/sidebar.png)

*Capture réelle : l'extension chargée dans VS Code, une réponse rendue par le panneau. Seul le
modèle qui répond est un serveur de test — le reste est le produit.*

---

## Pourquoi

GitHub Copilot est excellent et pose deux problèmes à une entreprise :

1. **Le code part.** Chaque frappe, chaque fichier ouvert, chaque question part chez un tiers.
   Pour beaucoup d'équipes — santé, défense, banque, sous-traitance sous NDA — ce point suffit à
   fermer le dossier.
2. **Le coût est structurel.** Le produit envoie tout à un gros modèle distant, parce que c'est le
   produit. On paie par développeur, tous les mois, pour des complétions dont 90 % sont triviales.

Hivey Forge inverse les deux : **le défaut est le modèle qui tourne déjà sur votre machine**, le
modèle distant est une **escalade** qu'il faut justifier, consentir et payer sur un budget ; et tout
ce qui sort est **anonymisé de façon réversible** avant de partir.

## Ce que ça sait faire

| | |
|---|---|
| **Complétion inline** | Remplissage au milieu (FIM) avec le modèle de code local. Anti-rebond, annulation, cache « frappe à travers » qui sert la suite d'une suggestion **sans requête**. |
| **Discussion en barre latérale** | Streaming, pièces jointes (fichier actif, sélection, fichiers choisis), historique par espace de travail, choix du modèle, compteur de contexte et de coût. |
| **Mode agent** | L'assistant lit le dépôt, cherche, consulte les **diagnostics de l'éditeur**, modifie des fichiers et propose des commandes — **une approbation par action**, diff avant écriture, tout dans la pile d'annulation. |
| **Terminal** | La commande `forge` : le même noyau, en REPL, avec la sortie des commandes réellement capturée et un diff imprimé avant chaque écriture. |
| **Dans l'éditeur** | `Ctrl+I` réécrit la sélection sur place · clic droit → interroger la sélection · message de commit rédigé depuis l'index · « expliquer la sortie du terminal ». |
| **Correctifs rapides** | Sur une erreur signalée par votre serveur de langage : « Corriger avec Hivey Forge » et « Expliquer ce problème ». Le compilateur dit **quoi** et **où** ; le modèle n'a plus qu'à corriger — c'est ce qui rend un petit modèle local suffisant sur la majorité des cas. |
| **Raccourcis de saisie** | `#` ouvre le sélecteur de fichiers de VS Code · `/expliquer`, `/tests`, `/corriger`, `/revue`, `/doc` joignent le fichier actif et posent la bonne question. |
| **Contrôle du contexte** | Chaque échange peut être **rendu muet** (il reste affiché, il ne part plus), **épinglé** (il survit à la coupe), modifié ou supprimé. C'est le levier le plus direct sur la qualité **et** sur la facture. |
| **Confidentialité** | Anonymisation réversible, fichiers interdits, consentement avant la première destination, **journal des envois** et **rapport de coûts**. |

## Comment le coût tend vers zéro

Ce n'est pas un slogan, c'est une architecture. Cinq leviers, dans l'ordre de leur effet :

1. **La complétion ne s'escalade jamais.** C'est le trafic à haute fréquence — une requête par pause
   de frappe. Elle tourne sur un modèle de code local (7 B suffit) et coûte de l'électricité.
   Le routeur l'interdit d'escalade *quelle que soit* la politique configurée.
2. **On envoie une carte, pas le territoire.** Le contexte ambiant est une **carte du dépôt**
   (chemins + symboles de tête, extraits sans parseur natif), pas le contenu des fichiers. Quelques
   milliers de jetons décrivent un dépôt cent fois plus gros, et le modèle demande les deux fichiers
   qu'il lui faut au lieu qu'on lui en pousse quarante.
3. **Le cache de prompt.** Le préfixe stable (prompt système + carte du dépôt) est marqué
   `cache_control` sur Anthropic et bénéficie du cache implicite ailleurs. Une conversation de code
   renvoie presque le même contexte à chaque tour : c'est là que se joue l'essentiel de la facture.
4. **On ne demande pas quand c'est inutile.** Pas de requête au milieu d'un mot, ni devant du code
   existant, ni pour un contexte dont on sait déjà que le modèle n'a rien à dire ; et la suite d'une
   suggestion déjà obtenue est servie depuis le cache pendant que l'utilisateur la tape.
5. **Un budget qui refuse.** Plafond par requête (une invite emballée ne coûte pas un dîner) et
   plafond par jour, vérifiés **avant** l'appel sur une estimation, enregistrés **après** sur le coût
   réel quand le fournisseur le communique (OpenRouter le fait).

Résultat par défaut : **0 $**. Le premier centime dépensé est un choix explicite.

## Comment la confidentialité est tenue

Quatre étapes, dans cet ordre, sur tout ce qui part vers un fournisseur distant :

1. **Interdiction.** Un fichier qui correspond à `privacy.blockedGlobs` (`.env`, clés, `secrets/**`…)
   n'est jamais joint, ni en discussion, ni en complétion.
2. **Anonymisation réversible.** Identifiants (formes connues + filet à entropie), adresses e-mail,
   téléphones, IP, hôtes internes, comptes dans les chemins, et les **termes propres à votre
   organisation** que vous listez. `alice@corp.fr` devient `⟨EMAIL_1⟩` — **partout et toujours le
   même marqueur**, pour que le modèle puisse encore raisonner — et redevient `alice@corp.fr` chez
   vous, y compris dans le code qu'il renvoie.
3. **Refus.** Un secret détecté déclenche un avertissement modal ; il est de toute façon déjà
   remplacé. L'anonymisation « off » ne s'applique jamais aux identifiants : la vie privée est une
   préférence, un mot de passe n'en est pas une.
4. **Consentement.** Avant la première requête vers une destination donnée : ce qui part (volume,
   destination, modèle) et ce qui a été masqué.

Ensuite, **la preuve** : `Hivey Forge : Aperçu des données sortantes` liste chaque envoi distant —
horodatage, hôte, modèle, jetons, part servie par le cache, coût, catégories anonymisées. **Jamais
le contenu** : un journal de ce qu'on voulait garder privé n'est pas une fonction de confidentialité.

Les points où d'autres se trompent, et qui sont traités ici :

- **Le point de terminaison décide, pas le nom du réglage.** Pointer le fournisseur « local » vers
  une URL publique déclenche l'anonymisation et le consentement comme n'importe quel autre.
- **Chaque étape de l'agent repasse la porte.** Un fichier que l'agent vient de lire est du texte
  neuf : il est ré-anonymisé avant l'appel suivant.
- **Le contenu joint est cloisonné.** Fichiers, journaux et pages arrivent dans un bloc clos par un
  **nonce par tour** ; une injection cachée dans un fichier ne peut pas fermer un bloc dont elle
  ignore le délimiteur.
- **Les clés vivent dans le trousseau du système** (`SecretStorage`), jamais dans `settings.json`
  — qui se synchronise et se committe par accident.

## Installation

```bash
git clone https://github.com/FlorianMartins/hivey-forge
cd hivey-forge
npm ci
npm run build
npx @vscode/vsce package --no-dependencies   # produit hivey-forge.vsix
code --install-extension hivey-forge.vsix
```

Côté modèle, le plus simple :

```bash
ollama pull qwen2.5-coder:7b   # complétion + discussion, ~5 Go
ollama serve
```

Rien d'autre à configurer : les valeurs par défaut visent `http://127.0.0.1:11434/v1`.

Pour ajouter une escalade distante : `Hivey Forge : Enregistrer une clé de fournisseur`, puis
renseigner `hiveyForge.escalation.model` (par exemple `anthropic/claude-sonnet-4.5`).

### Le client terminal

```bash
npm link            # met `forge` dans le PATH
forge               # REPL dans le dossier courant
forge "pourquoi ce test est instable ?"   # question unique
```

Configuration par `.hivey-forge.json` (dossier courant, puis `~`) — un projet peut donc committer
sa configuration d'équipe sans committer de clé (`apiKeyEnv` nomme la variable d'environnement).

## Déploiement en entreprise

- Servez un modèle une fois pour tous : **vLLM** ou **Ollama** derrière une URL interne, et poussez
  `hiveyForge.endpoints.local` par la stratégie de réglages VS Code.
- Verrouillez ce qui doit l'être : `privacy.blockedGlobs`, `privacy.customTerms` (noms de clients,
  de projets), `privacy.egressPolicy: "ask-always"`, `budget.dailyUsd`.
- Les réglages `hiveyForge.*` sont validés par espace de travail : un dépôt sensible peut imposer
  `chat.provider: "local"` dans son `.vscode/settings.json`.
- L'extension n'embarque **aucune dépendance à l'exécution** : le paquet à auditer, c'est le bundle
  et rien d'autre. Le SBOM est publié à chaque CI.

## Architecture

```
src/core/         aucun import de `vscode` — testable sans éditeur
  redaction/      détecteurs, coffre de pseudonymes, politique
  providers/      OpenAI-compatible (Ollama, vLLM, LiteLLM, OpenRouter…) + Anthropic natif
  router/         local d'abord, escalade consentie, prix, budget
  completion/     FIM par famille de modèle, cache, nettoyage des réponses
  context/        carte du dépôt, symboles, imports
  session/        le transcript et le prompt qui en est dérivé
  agent/          la boucle outils : approbation déléguée, anonymisation en un seul point
src/extension/    la couche VS Code (barre latérale, complétion, commandes, porte de sortie)
src/cli/          le client terminal
src/webview/      le panneau (aucun `innerHTML` sur du texte de modèle)
```

Détails : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/PRIVACY.md`](docs/PRIVACY.md) · [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) ·
décisions : [`docs/adr/`](docs/adr).

## Développement

```bash
npm test               # construit les bundles, puis 95 tests (node:test)
npm run test:integration   # charge l'extension dans un vrai VS Code (7 tests, headless)
npm audit --audit-level=high   # 0 vulnérabilité : 5 outils de dev, aucune dépendance à l'exécution
npm run typecheck
npm run scan:secrets   # scanne ce dépôt avec les détecteurs de l'extension elle-même
npm run models         # régénère le catalogue de prix depuis OpenRouter
```

La CI enchaîne types, tests, tests d'intégration dans un VS Code réel, auto-scan de secrets,
`npm audit`, CodeQL, empaquetage du `.vsix` et SBOM. Le catalogue de prix est régénéré chaque jour par un job planifié : **aucune version ni aucun
prix n'est écrit à la main**.

## État

`0.1.0` — utilisable au quotidien, pas encore publié sur les places de marché.
Ce qui est fait et ce qui ne l'est pas : [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Licence

Apache-2.0.

---

### In short (English)

Hivey Forge is an open-source coding assistant for VS Code, built for teams that cannot send their
source code to a third party. It defaults to a model running on your own machine (Ollama, LM Studio,
vLLM, llama.cpp) and treats a remote provider (OpenRouter, Azure, Anthropic, any OpenAI-compatible
gateway) as an escalation that must be justified, consented to, and paid for from a budget.
Everything that does leave is **reversibly pseudonymised** — credentials, identities, hosts, paths
and your own confidential terms are replaced by stable markers the model can still reason about, and
restored on your machine.

It ships inline completion, a sidebar chat with an agent mode (approval per action), a terminal
client, and editor commands. **Zero runtime dependencies, zero telemetry, Apache-2.0.**
