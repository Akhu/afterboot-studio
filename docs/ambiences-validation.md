# Validation du 2 novembre 2026

MacBook Pro M5 Max, 18 cœurs CPU, 128 Go de mémoire. Runtime officiel Stable Audio 3 MLX, révision `790793b89ddceea612be9ce42ff6830d18f6fa57`. Python 3.11.15, MLX 0.32.4 et dépendances verrouillées dans `requirements-ambiences.txt`.

| Vérification | Résultat | Nature du test |
| --- | --- | --- |
| `npm test` | 46 tests réussis, aucun ignoré | Modèles simulés pour les contrats HTTP ; FFmpeg réel pour les traitements audio |
| Lanceur d’installation complet | Réussi, environnement isolé, poids officiels en cache | Installation réelle |
| Small-Music sur MLX | WAV stéréo de 5 s à 44,1 kHz, non silencieux, valeurs finies | Génération IA réelle |
| Small-SFX sur MLX | WAV stéréo de 5 s à 44,1 kHz, non silencieux, valeurs finies | Génération IA réelle |
| Parcours du formulaire Small-Music | Seed fixe, souffle rose, fondu, original et copie téléchargables | Navigateur et moteur réels, bibliothèque QA séparée |
| Parcours du formulaire Small-SFX | Exemple de vent, seed aléatoire, sans souffle ni fondu | Navigateur et moteur réels, bibliothèque QA séparée |
| Favoris et reprise | Filtre favoris puis restauration dans Ambiances, modèle Small-SFX et seed conservés | Navigateur réel |
| Français et anglais | Labels, exemples et états vérifiés, prompt conservé | Navigateur visible et captures |
| Bibliothèque habituelle | 63 anciennes prises strictement identiques ; 2 prises réelles ajoutées, total 65 | Comparaison des enregistrements avant/après |
| Lecture audio | Deux lecteurs WAV de 5 s démarrent dans le navigateur | Décodage et lecture réels |
| File occupée, concurrence, erreurs et redémarrage | Refus avant lancement ou état d’échec explicite, sans relance implicite | Tests HTTP avec moteur simulé |

Après compilation initiale, la validation CLI a mesuré environ 0,47 s de calcul par prise de cinq secondes et 1,66 Go de mémoire au pic. Le parcours HTTP final a pris environ 848 ms pour Small-Music avec FFmpeg et 617 ms pour Small-SFX, y compris lancement du processus et suivi. Ces mesures dépendent du cache et ne prédisent pas les autres durées.

Les prises finales se nomment **Ambiances · Validation small-music** et **Ambiances · Validation small-sfx** dans la bibliothèque habituelle. Les preuves locales sont dans `.data/ambience-validation.json` et `.data/ambience-integration-report.json`. Les captures FR/EN sont dans `output/playwright/`, exclu de Git.

Les téléchargements anonymes Hugging Face ont réussi. Aucun jeton demandé dans le chat. Le fonctionnement d’un compte soumis à acceptation des conditions n’a pas été testé avec un vrai refus d’accès ; le code d’erreur correspondant est couvert avec un moteur simulé.

## Limites et contrôle manuel

- La durée maximale de 120 s est couverte par la validation d’entrée et par le contrat officiel. Les générations réalisées ici font cinq secondes. La qualité artistique, la continuité sur deux minutes et l’absence musicale totale de percussion restent à juger à l’écoute.
- Le lancement de la lecture prouve le décodage du WAV dans le navigateur. Il ne remplace pas une écoute humaine.
- Afterboot bloque ses propres générations concurrentes et vérifie la file ACE-Step. Les clients externes ne partagent pas de réservation atomique ; les laisser au repos.
- Le redémarrage final écoute uniquement sur `127.0.0.1:3210`. L’ancienne instance utilisait le réseau local ; le contrôle automatique a refusé de rétablir cette exposition réseau.

Pour valider personnellement le rendu : ouvrir Ambiances, écouter les deux prises, comparer le WAV traité de Small-Music à son original, puis reprendre les réglages. Vérifier la seed et le modèle, essayer le souffle sombre à −40 dB, puis passer en anglais et revenir en français. Les téléchargements doivent rester lisibles et le prompt utilisateur inchangé.
