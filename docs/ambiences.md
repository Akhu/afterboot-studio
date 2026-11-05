# Ambiances · Stable Audio 3

## Installation sur un Mac Apple Silicon

1. Installer Node.js 20+, [uv](https://docs.astral.sh/uv/getting-started/installation/) et FFmpeg, par exemple `brew install uv ffmpeg`.
2. Lancer l’API ACE-Step habituelle sur le port 8001. Laisser sa file vide.
3. Double-cliquer sur **Installer les ambiances.command**. Le lanceur récupère les sources officielles à une révision fixe, crée `.venv-ambiences` avec Python 3.11, installe les dépendances verrouillées et télécharge les poids nécessaires. Prévoir environ 2,6 Go pour les poids et l’environnement.
4. L’installation génère réellement deux WAV de cinq secondes et vérifie durée, stéréo, fréquence, valeurs finies et absence de silence. MLX est activé seulement après cette validation. Les preuves sont dans `.data/ambience-validation.json` et `.data/ambience-validation-small-*.wav`.
5. Lancer **Lancer le studio.command**, puis ouvrir **Ambiances**. Si le studio était déjà ouvert, le relancer, puis recharger la page.

Le moteur utilise Metal via MLX, sans CUDA ni PyTorch/MPS. La première utilisation compile certains calculs. Les mesures des sources officielles ne constituent pas une promesse de performance sur votre Mac.

## Hugging Face

Les poids optimisés officiels étaient téléchargeables anonymement lors de la validation sur M5 Max. Si l’accès est refusé ou limité :

1. Ouvrir [le dépôt des poids optimisés](https://huggingface.co/stabilityai/stable-audio-3-optimized), [Small-Music](https://huggingface.co/stabilityai/stable-audio-3-small-music) et [Small-SFX](https://huggingface.co/stabilityai/stable-audio-3-small-sfx). Se connecter dans le navigateur et accepter les conditions si demandé. Consulter aussi la [licence Stability AI](https://stability.ai/license) et les conditions des composants.
2. Depuis le dossier du studio, lancer dans le terminal :

```sh
HF_HOME="$PWD/.cache-ambiences/huggingface" .venv-ambiences/bin/hf auth login
```

3. Saisir le jeton uniquement dans l’invite locale masquée du terminal. Ne pas le mettre dans le chat, un fichier du dépôt, une capture ou une ligne de commande. Ne pas l’ajouter aux identifiants Git.
4. Relancer l’installateur. Les téléchargements déjà terminés sont réutilisés.

Le cache des poids et des éventuels identifiants reste dans `.cache-ambiences`, exclu de Git. Après installation, les prises du studio imposent le mode hors ligne Hugging Face.

## Utilisation

- **Nappes musicales / Small-Music** : drones et nappes éthérées. Le serveur ajoute une consigne sans batterie, percussion, rythme ni voix. L’adhésion au prompt dépend du modèle.
- **Textures sonores / Small-SFX** : vent, souffle et grondements continus. Le serveur ajoute une consigne sans musique ni parole.
- Prompt libre, exemples propres à chaque mode, durée entière de 5 à 120 secondes, seed fixe ou aléatoire. Les descriptions anglaises sont recommandées par Stability AI.
- Le souffle séparé propose désactivé, blanc, rose, brun ou sombre. Son volume va de −60 à −12 dB. FFmpeg l’ajoute après génération sur une copie WAV.
- Le fondu final est facultatif. Sa durée effective ne dépasse pas la moitié de la prise, par exemple 2,5 secondes sur une prise de 5 secondes.
- L’original est conservé. La bibliothèque commune propose lecteur, téléchargement WAV traité et original, favoris, JSON des réglages, reprise et variation. Les prises Ambiances se restaurent dans Ambiances, les prises ACE-Step dans Composer. Les deux formulaires gardent des brouillons distincts.

## File et mémoire

### Albums et mix bouclés

Dans **Ambiances**, choisir **Un album**. Le nom de l’essai devient le nom d’album. Régler 1 à 100 morceaux, puis les bornes de durée, de 5 à 120 secondes. Chaque durée entière est tirée avant la génération. Le plan est enregistré avec la seed de base ; les seeds des pistes sont incrémentées. Une pause, un rechargement ou une reprise conservent ces choix. Une seed fixe permet de refaire le même plan de durées.

La file génère une piste à la fois. Les titres utilisent le nom d’album et un numéro à deux chiffres au minimum, par exemple `Brumes nocturnes - 01`. Les albums sont affichés dans Ambiances et dans la bibliothèque, avec progression, pause, reprise, arrêt, métadonnées et reprise des réglages. Arrêter termine la piste en cours puis conserve les morceaux finalisés. Le ZIP reste disponible pour les pistes finalisées d’un album en pause ou arrêté.

**Album ZIP** utilise l’exporteur ACE-Step : un MP3 320 kbit/s par piste, avec nom numéroté, titre, numéro et tag d’album. Le ZIP contient les pistes distinctes, pas toutes leurs répétitions. Les fichiers WAV et les originaux sont conservés et se téléchargent depuis la bibliothèque.

**Créer aussi un mix bouclé avec fondus** construit un WAV de durée cible, de 1 à 240 minutes, après la génération. Pour deux heures à partir de quinze morceaux, régler **15** et **120 minutes**. Le diffuseur ne génère que les quinze morceaux. Le mix parcourt des permutations de l’album jusqu’à la durée cible, en comptant les recouvrements des fondus. L’ordre enregistré reste le même lors d’une nouvelle tentative d’assemblage. Chaque passage change d’ordre quand il y a au moins deux morceaux ; avec trois ou plus, la même piste n’est pas répétée de part et d’autre d’une frontière de passage. Avec une seule piste, elle est répétée avec fondu sur elle-même.

Le fondu entre pistes doit être plus court que la moitié de la durée minimum. Le mix utilise les originaux pour éviter de répéter les fins adoucies des fichiers individuels. Le souffle est ajouté en un seul flux au mix complet, puis le fondu final est appliqué une fois. La sortie est coupée à la durée cible exacte. Cela rend les raccords progressifs, sans garantir une identité de timbre ou d’harmonie entre deux générations. La jonction entre la fin et le début du WAV exporté n’est pas conçue comme une boucle infinie sans couture.

L’assemblage prépare des corps de pistes et de courts raccords par paire dans un dossier temporaire, puis lit un manifeste concaténé en flux. Il évite un graphe FFmpeg chargeant toutes les répétitions en parallèle. Le WAV stéréo de deux heures occupe environ 1,27 Go. Un échec d’assemblage met l’album en pause ; **Reprendre** réutilise les prises existantes.

Afterboot refuse une nouvelle génération tant qu’une piste est en attente ou qu’une session longue réserve le studio. Avant Stable Audio, il vérifie `/v1/stats` d’ACE-Step. Si l’API est inaccessible ou occupée, la prise est refusée. Les sessions en pause doivent être terminées avant d’utiliser Ambiances.

Pour éviter la concurrence entre applications, lancer les générations depuis cette instance Afterboot et laisser les autres clients ACE-Step au repos. L’API ACE-Step ne fournit pas de réservation atomique commune avec Stable Audio : un client externe pourrait démarrer après la vérification. Ne pas utiliser deux instances du studio sur la même bibliothèque.

Chaque prise lance un processus Python distinct avec `--free-models`. L’encodeur texte et le diffuseur sont libérés progressivement, puis la sortie du processus libère sa mémoire Metal. ACE-Step conserve sa propre mémoire. Un arrêt du studio interrompt la prise locale ; au redémarrage, elle apparaît en échec avec ses réglages, sans relance automatique. Une prise dépassant 20 minutes est arrêtée. Si la génération a déjà produit un WAV mais que le traitement FFmpeg échoue, la prise reste en attente et la vérification du statut réessaie sur cet original, y compris après redémarrage, sans relancer le modèle.

## Vérification

`npm test` couvre les contrats HTTP avec modèles simulés, les verrous, la persistance et le vrai traitement FFmpeg. Ces tests ne prouvent pas une génération IA.

` .venv-ambiences/bin/python scripts/validate-ambiences.py` génère vraiment avec les deux modèles, et invalide la validation précédente en cas d’échec. L’API ACE-Step doit être lancée et au repos. Les fichiers de validation ne sont pas ajoutés à la bibliothèque.

Vérification manuelle :

1. Dans Ambiances, choisir un exemple Small-Music, durée 5 s, seed fixe, souffle rose à −32 dB et fondu 3 s. Générer. Attendre une prise prête, écouter, télécharger les deux WAV et le JSON. L’original doit garder son audio, la copie doit contenir le souffle et terminer en fondu.
2. Choisir Small-SFX et l’exemple de vent, désactiver souffle et fondu, activer seed aléatoire. Générer. Le JSON doit indiquer Small-SFX et la seed tirée.
3. Ajouter un favori, aller dans Bibliothèque, filtrer les favoris, reprendre les réglages. Le bon onglet, le modèle et la seed doivent être restaurés. Reprendre aussi une ancienne piste ACE-Step pour vérifier Composer.
4. Passer en anglais et revenir en français. Vérifier labels, états et exemples sans modification du prompt utilisateur.
5. Pendant une prise, vérifier que le lancement d’une autre prise est bloqué. Avec ACE-Step occupé, Ambiances doit renvoyer une erreur utile avant de charger MLX.

Les tests courts ne valident pas la qualité artistique ni toutes les durées jusqu’à 120 s. Une seed fixe sert à refaire les réglages ; l’identité binaire n’est pas garantie entre versions de MLX et matériels différents.

## Sources officielles et version

- [Code et interface officielle](https://github.com/Stability-AI/stable-audio-3), révision `790793b89ddceea612be9ce42ff6830d18f6fa57`.
- [Moteur MLX et options](https://github.com/Stability-AI/stable-audio-3/tree/790793b89ddceea612be9ce42ff6830d18f6fa57/optimized/mlx) : `sm-music`, `sm-sfx`, décodeur SAME-S, 8 étapes, diffuseur FP16, décodeur FP32, WAV stéréo 44,1 kHz.
- [Présentation des modèles](https://github.com/Stability-AI/stable-audio-3/blob/main/docs/guides/model-overview.md).

## English quick start

Start ACE-Step and leave its queue idle. Install Node.js 20+, uv and FFmpeg. Run **Installer les ambiances.command**, then **Lancer le studio.command**. The installer creates a project-local Python environment and runs two real five-second MLX generations before enabling acceleration. Choose **English** in Afterboot, then open **Ambiences**.

Small-Music generates drumless musical pads; Small-SFX generates continuous sound textures. Noise and optional fade are applied with FFmpeg to a separate WAV copy. Originals, metadata, favorites and settings reuse share the main library. Keep other ACE-Step clients idle. Each take exits its Python process to release Metal memory.

If Hugging Face denies access, accept the terms in your browser and use the local `hf auth login` command above. Never paste a token into chat. Run the installer again after login. Generation itself uses cached weights offline.

For an album, choose **An album**, enter a title, a track count and duration bounds. Durations and seeds are saved before the first generation; tracks are numbered from your title. Pause/resume preserves completed audio and the plan. **Album ZIP** exports finalized tracks as numbered 320 kbit/s MP3 files with album tags, using the ACE-Step exporter.

Enable the looping mix for an exact target such as 120 minutes. Every pass shuffles the existing tracks. Crossfades are counted toward the target; no additional generation happens for repeats. The mix uses originals, one continuous noise stream and one ending fade. Download the long WAV separately. Its final-to-first boundary is not an infinite seamless-loop guarantee. See [album validation](ambience-albums-validation.md).
