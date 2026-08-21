# État et suite

Honnête plutôt que flatteur : ce qui marche, ce qui manque, ce qui n'est pas vérifié.

## Fait (0.3.0)

- **Localisation** : interface en anglais dans la source, français en traduction (une table pour le
  panneau, l'extension et le CLI ; `package.nls.json` pour le manifeste). Suit la langue d'affichage
  de VS Code. Deux tests tiennent le catalogue : l'un échoue sur une chaîne sans traduction, l'autre
  sur une traduction devenue inutile.
- Métadonnées de place de marché (catégories, mots-clés, bannière, changelog) et
  `docs/PUBLISHING.md` : tout est prêt à publier, il manque les jetons.

## Fait (0.2.0)

- Noyau indépendant de l'éditeur : anonymisation, fournisseurs, routeur, budget, complétion,
  session, carte du dépôt, boucle d'agent. **95 tests**, dont des tests de protocole contre un vrai
  serveur HTTP et quatre tests bout-en-bout du client terminal.
- Barre latérale refondue (langage visuel de VS Code, zéro couleur propre) : quatre écrans —
  conversation, historique, modèles, permissions —, sélecteur de mode (discussion / plan / agent),
  réglage du raisonnement, menu de contexte (fichier actif, onglets ouverts, import disque,
  sélecteur `#`), recherche dans la conversation et dans l'historique, filtres d'historique,
  échanges muets / épinglés / modifiables / supprimables, compteurs de contexte et de coût.
- Permissions de l'agent : « une fois », « cette conversation », « toujours », « jamais », par
  forme d'action ; un refus l'emporte toujours.
- Comparateur de modèles : 411 modèles avec prix d'entrée, de sortie, de cache et fenêtre de
  contexte, plus ce que le point de terminaison local sert réellement.
- Complétion inline FIM, anti-rebond, cache « frappe à travers », préchauffage du modèle.
- Commandes d'éditeur : `Ctrl+I`, interroger la sélection, message de commit, expliquer le terminal.
- Client terminal `forge`, avec sortie de commande capturée et diff avant écriture.
- Porte de sortie : globs interdits, anonymisation, refus sur secret, consentement, journal, budget.
- Correctifs rapides sur les diagnostics de l'éditeur (« Corriger avec Forge »), commandes
  `/` dans la barre latérale, mention `#` qui ouvre le sélecteur de fichiers de VS Code, et
  lancement du client terminal depuis l'éditeur.
- **Tests d'intégration dans un vrai VS Code** (7, headless) : l'extension s'active, toutes les
  commandes déclarées sont enregistrées, les réglages ont les défauts annoncés, la complétion ne
  lève rien quand aucun serveur ne répond, les rapports s'ouvrent, les correctifs apparaissent.
- CI : types, tests, tests d'intégration, auto-scan de secrets, `npm audit`, CodeQL, `.vsix`, SBOM,
  catalogue de prix régénéré chaque jour.

## Pas encore fait

- **Publication** sur le Marketplace VS Code et Open VSX : préparée (`docs/PUBLISHING.md`), en
  attente des jetons d'éditeur — que seul Florian peut créer.
- **Autres langues** : la mécanique accepte n'importe quelle langue ; il n'y a que l'anglais et le
  français pour l'instant.
- **Qualité de génération mesurée.** Les tests de protocole utilisent un serveur factice ; la qualité et
  la latence des complétions avec `qwen2.5-coder:7b` n'ont pas pu être mesurées ici (machine sans
  GPU, charge moyenne > 100).
- **Symboles via le serveur de langage.** La carte du dépôt utilise des expressions régulières ;
  `DocumentSymbolProvider` donnerait mieux pour les fichiers déjà ouverts.
- **Construction reproductible** et signature du `.vsix`.
- **Politique d'entreprise centralisée** (un fichier de règles signé que l'extension refuse de
  contredire), au-delà des réglages d'espace de travail.
- **Historique partagé par équipe**, mode « revue de code » sur une branche, et lecture des sorties
  de terminal via l'API d'intégration shell.

## Points à surveiller

- `qwen2.5-coder:7b` sur CPU : la première requête charge 5 Go ; le préchauffage et `keep_alive`
  atténuent, ils ne suppriment pas. Sur un poste sans GPU, viser un modèle 1,5 B pour la complétion
  et garder le 7 B pour la discussion.
- Le `fetch` de Node abandonne une réponse dont les en-têtes tardent : la couche HTTP le traduit en
  « le modèle est probablement en train de charger », mais un poste très lent verra des complétions
  vides tant que le modèle n'est pas résident.
