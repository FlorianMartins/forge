# État et suite

Honnête plutôt que flatteur : ce qui marche, ce qui manque, ce qui n'est pas vérifié.

## Fait (0.1.0)

- Noyau indépendant de l'éditeur : anonymisation, fournisseurs, routeur, budget, complétion,
  session, carte du dépôt, boucle d'agent. **95 tests**, dont des tests de protocole contre un vrai
  serveur HTTP et quatre tests bout-en-bout du client terminal.
- Barre latérale : streaming, mode agent avec approbation par action, pièces jointes, historique,
  échanges muets / épinglés / modifiables / supprimables, compteurs de contexte et de coût.
- Complétion inline FIM, anti-rebond, cache « frappe à travers », préchauffage du modèle.
- Commandes d'éditeur : `Ctrl+I`, interroger la sélection, message de commit, expliquer le terminal.
- Client terminal `forge`, avec sortie de commande capturée et diff avant écriture.
- Porte de sortie : globs interdits, anonymisation, refus sur secret, consentement, journal, budget.
- CI : types, tests, auto-scan de secrets, `npm audit`, CodeQL, `.vsix`, SBOM, catalogue de prix
  régénéré chaque jour.

## Pas encore fait

- **Publication** sur le Marketplace VS Code et Open VSX.
- **Localisation.** L'interface est en français en dur ; il faut passer par `package.nls.json` et
  une table de chaînes (l'anglais d'abord).
- **Vérification dans un vrai VS Code.** Le code est typé, construit et testé unitairement, mais
  l'extension n'a pas encore été chargée dans un éditeur : la machine de développement n'a pas
  d'affichage. C'est la première chose à faire.
- **Génération réelle mesurée.** Les tests de protocole utilisent un serveur factice ; la qualité et
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
