# Sécurité

## Signaler une faille

Écrivez à **florian.martins@gmail.com** avec « forge » dans l'objet, ou ouvrez un
*security advisory* privé sur GitHub. Merci de ne pas ouvrir d'issue publique avant correction.

Réponse sous 72 h, correctif visé sous 14 jours pour ce qui permet une fuite de données ou une
exécution non consentie.

Sont particulièrement bienvenus :

- un chemin par lequel du contenu part vers un fournisseur distant **sans** passer par
  `EgressGate.prepare()` ;
- une injection indirecte qui obtient une action (écriture, commande) sans approbation humaine ;
- une évasion de l'espace de travail par un argument d'outil ;
- un secret d'une forme courante que `src/core/redaction/detectors.ts` laisse passer — joignez un
  exemple **synthétique**, jamais une vraie clé ;
- une exécution de script dans le panneau (la CSP et l'absence d'`innerHTML` devraient l'empêcher).

## Périmètre

Ce qui relève du modèle de menace : `docs/THREAT-MODEL.md`, y compris les résidus assumés. Un poste
déjà compromis, une passerelle « interne » qui réexpédie vers l'extérieur, ou un utilisateur qui
règle `redaction: "off"` et `egressPolicy: "trust"` sont hors périmètre — l'outil rend ces choix
explicites, il ne les interdit pas.

## Versions

Seule la dernière version publiée reçoit des correctifs. Le projet est en `0.x` : l'interface de
configuration peut encore changer.
