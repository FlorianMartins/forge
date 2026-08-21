# ADR-0001 — Local d'abord, distant par escalade consentie

**Date** : 2026-08-21 · **Statut** : accepté

## Contexte

Un assistant de code hébergé envoie tout à un gros modèle distant : c'est son produit. Cela donne
deux propriétés dont une entreprise ne veut pas — le code sort, et le coût est mensuel par
développeur pour des complétions dont l'immense majorité est triviale.

## Décision

Le défaut est le modèle qui tourne sur la machine ou le réseau de l'utilisateur. Le distant est une
**escalade** : il faut un signal (contexte plus grand que la fenêtre locale, question de diagnostic
ou d'architecture), une politique qui l'autorise (`never` / `ask` / `auto`, défaut `ask`), et un
budget qui la couvre.

Trois classes de travail **ne s'escaladent jamais**, quelle que soit la politique : complétion
inline, embeddings, corvées (titres, messages de commit). Ce sont les tâches à haute fréquence, et
ce sont exactement celles qu'un modèle de code 7 B fait bien.

## Conséquences

- Coût par défaut : zéro. Le premier centime est un choix explicite, visible dans le rapport.
- Qualité en discussion : inférieure à un grand modèle sur les questions difficiles. C'est pourquoi
  l'escalade existe, et pourquoi le routeur la **propose** au lieu de la subir ou de l'interdire.
- Le routeur ne dépense jamais de lui-même : il retourne une recommandation, l'appelant demande.
