# ADR-0004 — Zéro dépendance à l'exécution

**Date** : 2026-08-21 · **Statut** : accepté

## Contexte

Une extension VS Code s'exécute dans l'hôte d'extension : accès complet au système de fichiers, au
réseau et au trousseau. Une dépendance compromise y dispose de tout. Or l'argument de vente de ce
projet est précisément qu'on peut lui confier du code confidentiel.

## Décision

Le paquet publié n'embarque **aucune dépendance à l'exécution**. Sont écrits à la main : le
décodage SSE, le glob, le diff, l'estimation de jetons, le rendu Markdown du panneau, l'extraction
de symboles, les détecteurs de secrets. Les seuls paquets présents (`typescript`, `esbuild`,
`@types/node`, `@types/vscode`) ne servent qu'à construire et ne partent jamais dans le `.vsix`.

Le principe vaut aussi pour l'outillage : les tests d'intégration ont d'abord été écrits sur mocha,
et `npm audit` a cassé la CI le jour même (`serialize-javascript`, RCE, sévérité haute, tirée par
mocha). Plutôt que d'abaisser le seuil de l'audit, le lanceur a été réécrit en quarante lignes
(`src/test/suite/tiny.ts`) et mocha retiré avec ses 114 paquets. **Un garde-fou qu'on désarme la
première fois qu'il sonne n'en est pas un.**

## Conséquences

- Le code à auditer est le code de ce dépôt, et rien d'autre. Un SBOM est publié à chaque CI.
- Quelques centaines de lignes de plus à maintenir — et à tester, ce qui est fait.
- Deux compromis assumés : pas de tokenizer BPE (l'estimation de jetons est heuristique et
  volontairement pessimiste), pas de tree-sitter (les symboles viennent d'expressions régulières,
  ou du serveur de langage quand il est disponible).
- La reproductibilité de la construction reste à faire : `esbuild` et `typescript` sont eux-mêmes
  dans la chaîne d'approvisionnement.
