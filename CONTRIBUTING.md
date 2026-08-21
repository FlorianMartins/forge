# Contribuer

## Démarrer

```bash
npm ci
npm test            # construit les bundles puis lance la suite
npm run watch       # reconstruction continue, puis F5 dans VS Code
```

`F5` ouvre une fenêtre d'extension de développement. Le canal de sortie « Hivey Forge » raconte ce
qui se passe.

## Ce qui est attendu d'un changement

1. **Un test qui échoue avant.** La suite tourne en une seconde ; il n'y a pas d'excuse.
2. **Rien de nouveau dans `dependencies`.** Voir `docs/adr/0004`. Une exception se discute dans une
   issue avant le code.
3. **`src/core/` n'importe jamais `vscode`.** Si votre règle a besoin de l'éditeur, elle appartient
   à `src/extension/` ; si elle a besoin des deux, elle appartient au noyau avec un rappel injecté.
4. **Tout nouveau chemin réseau passe par `EgressGate.prepare()`**, et tout nouvel outil déclare son
   `approval()`.
5. **`npm run scan:secrets` passe.** Il scanne ce dépôt avec les détecteurs de l'extension : s'il
   crie sur du code ordinaire, c'est la règle qu'il faut corriger, avec un test de non-régression.

## Style

- Commentaires en anglais, interface et documentation en français (pour l'instant : la localisation
  est au programme).
- Un commentaire explique **pourquoi**, jamais **quoi**. Le quoi se lit dans le code.
- Messages de commit à l'impératif, préfixe *conventional commits*, corps qui dit pourquoi.
