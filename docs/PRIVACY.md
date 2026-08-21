# Traitement des données

Fiche factuelle, pour une équipe sécurité ou un DPO qui doit valider l'outil. Elle décrit ce que
l'extension fait, pas ce qu'elle promet.

## Ce qui est traité, et où

| Donnée | Traitement | Sort de la machine ? |
|---|---|---|
| Code du fichier en cours (préfixe/suffixe du curseur) | Complétion inline | **Non** avec la configuration par défaut (serveur local). Oui si `completion.provider` est distant — et alors anonymisé. |
| Fichiers ouverts voisins (≤ 2, 1 200 caractères) | Contexte de complétion | Idem. |
| Chemins + symboles de tête du dépôt | Carte du dépôt jointe à la discussion | Oui si la discussion est distante. **Les corps de fichiers ne sont pas envoyés** — seulement les signatures. |
| Fichier ou sélection que vous joignez | Discussion | Oui si distante, anonymisé, après consentement. |
| Fichiers lus par l'agent | Discussion en mode agent | Idem, ré-anonymisés à **chaque** étape. |
| Diff indexé (`git diff --cached`) | Message de commit | Idem. |
| Sélection du terminal | « Expliquer la sortie » | Idem. |
| Clés d'API | Trousseau du système (`SecretStorage`) | Envoyées uniquement au fournisseur concerné, dans l'en-tête d'autorisation. |
| Historique des discussions | `workspaceState` de VS Code, sur le disque local | **Non.** |
| Journal des envois | `globalState` de VS Code, sur le disque local | **Non.** Métadonnées seulement. |
| Statistiques d'usage | Compteur en mémoire, remis à zéro à chaque session | **Aucune télémétrie, nulle part.** |

## Ce qui n'est jamais journalisé

Le journal des envois (`Aperçu des données sortantes`) contient : horodatage, hôte, modèle, nombre
de jetons, part servie par le cache, coût, **catégories** anonymisées (`EMAIL×3, HOST×1`).
Il ne contient ni le prompt, ni la réponse, ni une seule valeur masquée. Le coffre qui relie un
marqueur à sa vraie valeur vit en mémoire, meurt avec la conversation et n'est jamais sérialisé.

## Anonymisation : ce qui est reconnu

- **Identifiants** — formes AWS, GitHub, Slack, Stripe, OpenAI, Anthropic, OpenRouter, Google, npm,
  Hugging Face, JWT, blocs PEM, identifiants dans une URL de connexion, valeurs assignées à un nom
  de secret, plus un filet à entropie pour le reste.
- **Personnes** — adresses e-mail, numéros de téléphone.
- **Machines** — IPv4/IPv6 (hors loopback), adresses MAC, hôtes en `.internal/.corp/.local/.lan/…`.
- **Disposition** — le compte utilisateur dans `/home/…`, `/Users/…`, `C:\Users\…`.
- **Vos termes** — la liste `privacy.customTerms` : clients, projets, marques internes.

Le remplacement est **stable et réversible** : la même valeur donne toujours le même marqueur dans
une conversation (le modèle peut donc encore raisonner : « la même adresse apparaît dans le test et
dans la fixture »), et les marqueurs redeviennent les vraies valeurs sur votre machine, y compris
dans le code renvoyé.

## Configuration recommandée en entreprise

Dans `.vscode/settings.json` d'un dépôt sensible, ou par stratégie de réglages :

```jsonc
{
  "hiveyForge.chat.provider": "local",
  "hiveyForge.completion.provider": "local",
  "hiveyForge.endpoints.local": "https://llm.interne.exemple/v1",
  "hiveyForge.privacy.redaction": "strict",
  "hiveyForge.privacy.egressPolicy": "ask-always",
  "hiveyForge.privacy.customTerms": ["NomDuClient", "ProjetInterne"],
  "hiveyForge.privacy.blockedGlobs": ["**/.env*", "**/*.pem", "**/secrets/**", "**/donnees-clients/**"],
  "hiveyForge.escalation.policy": "never",
  "hiveyForge.budget.dailyUsd": 0
}
```

Avec `escalation.policy: "never"` et deux fournisseurs locaux, **aucun octet ne quitte le réseau**,
et le journal des envois le montre : il reste vide.

## Vérifier plutôt que croire

1. `Hivey Forge : Aperçu des données sortantes` — la liste des envois distants.
2. Le canal de sortie « Hivey Forge » — chaque activation journalise le fournisseur, l'URL et le
   niveau d'anonymisation ; chaque complétion journalise sa latence et son volume.
3. Un proxy ou `tcpdump` sur le poste : l'extension n'ouvre aucune autre connexion. Pas de serveur
   de télémétrie, pas de vérification de licence, pas de catalogue distant au démarrage (le
   catalogue de prix est un fichier généré et embarqué).
