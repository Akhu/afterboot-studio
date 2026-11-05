# Validation des albums du 5 novembre 2026

Version 0.12.0, MacBook Pro M5 Max, Stable Audio 3 via le runtime MLX officiel épinglé. Les essais réels utilisent une bibliothèque de démonstration séparée, `.data/album-qa`, afin de préserver les prises personnelles.

| Vérification | Résultat | Nature du test |
| --- | --- | --- |
| Suite `npm test` | 51 tests réussis, aucun ignoré | Modèles simulés pour les contrats HTTP ; FFmpeg réel pour les traitements, exports et durées |
| Album Small-Music | 15 prises WAV réelles, de 64 à 120 s, dans les bornes demandées de 60 à 120 s | Génération IA réelle, lancée depuis le formulaire |
| Durées enregistrées | 119, 78, 89, 109, 91, 81, 64, 106, 120, 110, 88, 117, 114, 119, 98 s | 1 503 s de musique originale ; seed de base 12345, incrémentée par piste |
| Mix bouclé | Exactement 7 200 s, soit deux heures, 1 270 080 078 octets | FFmpeg réel à partir des 15 générations réelles, fondus de 2 s, souffle rose à −32 dB et fin de 6 s |
| ZIP de l’album | 15 MP3 numérotés, 60 160 955 octets | Export réel, archive ouverte et noms vérifiés, tags titre/album/numéro inspectés avec FFprobe |
| Album Small-SFX | 3 prises réelles de 7, 7 et 5 s, dans les bornes de 5 à 7 s | Génération IA réelle, sans mix bouclé |
| Reprise après moteur inaccessible | Album mis en pause avant toute prise, puis repris avec le même plan | Incident réel lors du redémarrage du lanceur commun ACE/Afterboot |
| Pause/reprise après redémarrage | Durées, seeds, noms et prises terminées conservés | Test HTTP avec modèle simulé et traitement FFmpeg réel |
| Échec d’assemblage puis reprise | Mix reconstruit sans régénérer les pistes | Panne simulée à l’assemblage, FFmpeg réel à la reprise |
| Continuité des raccords | Pas de trous silencieux sur les sources de test, durée exacte, fin silencieuse et originaux inchangés | Test FFmpeg réel avec trois sources synthétiques, avec et sans fondu |
| Ordres des passages | Permutations complètes, ordre changé, pas de répétition à la frontière pour 15 pistes | Test déterministe sur une cible de deux heures |
| Bibliothèque personnelle | 67 prises préexistantes strictement identiques | Comparaison des enregistrements avant/après les essais |

Les noms du ZIP sont `Brumes nocturnes - 01.mp3` jusqu’à `Brumes nocturnes - 15.mp3`. Le premier MP3 porte le titre `Brumes nocturnes - 01`, l’album `Brumes nocturnes` et le numéro `1/15`. Les WAV originaux sont conservés. Le rapport détaillé local se trouve dans `.data/album-qa/validation-report.json`, exclu de Git.

Les captures FR/EN des README proviennent de la vraie interface et de ces albums de démonstration. La navigation, la traduction et les réglages d’album restent vérifiables dans le navigateur.

## Contrôle manuel

1. Ouvrir Ambiances et choisir Un album. Saisir `Essai album`, 3 morceaux, bornes 5 et 8 s, seed fixe. Lancer. Attendre trois pistes `Essai album - 01`, `- 02`, `- 03`, chacune dans les bornes.
2. Depuis la carte d’album, ouvrir le plan puis exporter Album ZIP. Vérifier trois MP3 numérotés et les tags d’album. Les fichiers WAV et originaux doivent rester disponibles dans la bibliothèque.
3. Reprendre les réglages de l’album. Activer le mix bouclé, régler 1 minute et 2 s de fondu. Lancer un nouvel album. Le WAV final doit durer exactement 60 s et les transitions doivent rester progressives.
4. Pendant une prise, mettre en pause. Attendre la fin de la piste en cours, recharger puis reprendre. Les durées prévues et les seeds restent les mêmes ; aucune piste terminée ne doit être régénérée. Un ZIP partiel doit être exportable pendant la pause.
5. Passer en anglais puis revenir en français. Vérifier les labels d’album et de mix sans modification du prompt ni des valeurs saisies. Retrouver les albums dans la bibliothèque et reprendre aussi une ancienne piste ACE-Step dans Composer.

## Limites

Le WAV de deux heures a été généré et sa durée vérifiée. Il n’a pas été écouté intégralement pendant deux heures. Les fondus rendent les raccords progressifs ; ils ne garantissent pas une continuité artistique parfaite entre harmonies ou textures. La fin du fichier n’est pas garantie raccordable sans couture à son début.

La génération d’une longue session ACE-Step reste distincte de cette validation Stable Audio. Les 51 tests automatisés ne constituent pas 50 générations IA réelles. Les clients externes ACE-Step doivent rester au repos, car l’API ne propose pas de réservation atomique commune avec Stable Audio.
