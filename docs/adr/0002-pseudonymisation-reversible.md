# ADR-0002 — Pseudonymisation réversible plutôt que masquage

**Date** : 2026-08-21 · **Statut** : accepté

## Contexte

Anonymiser avant d'envoyer est facile ; anonymiser sans rendre l'assistant inutile ne l'est pas.
Remplacer chaque valeur sensible par `***` ou par un hachage produit une réponse pleine d'étoiles
et un modèle incapable de voir que deux occurrences sont la même chose.

## Décision

Chaque valeur détectée est remplacée par un marqueur **typé et stable** : `⟨EMAIL_1⟩`, `⟨HOST_2⟩`.
Même valeur ⇒ même marqueur pour toute la conversation. Un coffre en mémoire fait la correspondance
dans les deux sens ; il n'est jamais écrit sur le disque et meurt avec la conversation. Les réponses
sont détraduites **au fil du flux**, si bien que l'utilisateur ne lit jamais ses propres données à
travers un marqueur.

Le prompt système explique les marqueurs et interdit d'en inventer des valeurs plausibles.

## Conséquences

- Le modèle raisonne encore : « la même adresse apparaît dans le test et dans la fixture ».
- Le code renvoyé est utilisable tel quel : les marqueurs redeviennent les vraies valeurs.
- Un texte qui contient littéralement `⟨EMAIL_1⟩` est neutralisé en `<EMAIL_1>` à l'entrée, sinon la
  détraduction serait détournable.
- Limite assumée : le fournisseur voit la **structure** (« il y a trois adresses, dont deux
  identiques »). C'est le prix de l'utilité.
