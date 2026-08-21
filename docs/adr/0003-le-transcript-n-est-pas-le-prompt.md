# ADR-0003 — Le transcript n'est pas le prompt

**Date** : 2026-08-21 · **Statut** : accepté

## Contexte

Les assistants nés d'une fenêtre de discussion renvoient tout l'historique à chaque tour. Le seul
levier offert à l'utilisateur est « nouvelle conversation ». C'est cher (l'historique est refacturé
à chaque tour) et imprécis (une mauvaise réponse empoisonne les dix suivantes).

## Décision

La conversation est un **journal** que l'utilisateur possède. Ce que le modèle voit en est dérivé à
chaque tour, avec trois actions par échange :

- **muet** — reste à l'écran, sort du prompt ;
- **supprimer** — quitte le journal (supprimer une question supprime sa réponse) ;
- **épingler** — survit à la coupe quand le budget de contexte est atteint.

Modifier une question supprime tout ce qui la suit : les réponses portaient sur l'ancienne
formulation. Un tour en échec n'est jamais rejoué comme s'il était une réponse.

## Conséquences

- Le levier le plus direct sur la qualité **et** sur la facture, sans jargon : ce qui est muet ne
  coûte rien et n'influence rien.
- La coupe automatique est **rapportée** (`trimmed`), jamais silencieuse.
- Reprise identique dans les deux surfaces : icône dans la barre latérale, `/muet n` dans le
  terminal.
