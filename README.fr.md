# Afterboot Studio

[English](README.md) · [Français](README.fr.md)

Un studio musical rétro pour l'[API officielle ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5). Crée des instrumentaux, garde les seeds sous les yeux et retrouve tes morceaux dans une bibliothèque locale.

Interface communautaire indépendante. ACE-Step fonctionne séparément et assure toute la génération musicale. Aucun modèle n'est inclus.

![Afterboot Studio en français](docs/screenshots/fr.jpg)

## État du projet

La version 0.4.0 est une première préversion. L'interface a été vérifiée dans un navigateur et l'intégration API dispose de tests automatisés avec un serveur ACE-Step simulé. La génération complète avec une installation réelle d'ACE-Step reste à valider. Les performances dépendent du moteur, des modèles et du matériel.

## Fonctionnalités

- Interface en anglais et français, avec mémorisation du choix par navigateur.
- Création d'instrumentaux avec prompt, tempo, durée et seed toujours visibles.
- Préréglages jungle, liquid DnB et ambient.
- ACE-Step Turbo, 8 étapes, un morceau à la fois et planification 5Hz LM facultative.
- Suivi réel des tâches, repris après rechargement de la page.
- Écoute, recherche, favoris et reprise des paramètres d'un morceau.
- Téléchargement WAV, FLAC ou MP3 et métadonnées de génération en JSON.
- Accès depuis un autre ordinateur du réseau privé.

Changer la langue conserve les prompts, titres et réglages. Les prompts des préréglages restent en anglais. Les messages bruts du moteur conservent leur langue d'origine.

La seed seule ne garantit pas une reproduction identique entre versions de modèles, matériels ou nouvelles planifications LM.

## Prérequis

- Node.js 20 ou plus récent.
- Une API REST ACE-Step 1.5 installée et fonctionnelle avec le modèle Turbo.
- Un navigateur récent.

Aucune dépendance npm à installer pour cette interface. ACE-Step conserve ses propres dépendances et téléchargements de modèles. Commence par son [guide d'installation](https://github.com/ace-step/ACE-Step-1.5#readme).

## Démarrage local

Lance l'API depuis ton installation ACE-Step. Sur macOS avec Apple Silicon, le lanceur officiel est :

~~~bash
bash start_api_server_macos.sh
~~~

Attends la fin du chargement. L'adresse API par défaut est http://127.0.0.1:8001. Arrête d'abord ton processus Gradio si tu utilises la même installation et souhaites éviter de charger les modèles deux fois.

Dans un second terminal :

~~~bash
git clone https://github.com/Akhu/afterboot-studio.git
cd afterboot-studio
npm start
~~~

Ouvre [Afterboot Studio](http://127.0.0.1:3210).

Sur macOS, tu peux aussi double-cliquer sur `Lancer le studio.command`. Ce fichier démarre uniquement l'interface. Lance ACE-Step séparément.

Pour commencer, essaie 60 secondes à 170 BPM. L'interface accepte 10 à 600 secondes, mais ton moteur et ton matériel peuvent imposer des limites inférieures.

## Accès depuis le réseau local

Si l'interface et ACE-Step tournent sur la même machine, laisse Python sur son adresse locale par défaut. Lance l'interface avec :

~~~bash
npm run start:lan
~~~

Le terminal affiche les adresses réseau. Depuis un autre appareil connecté au même réseau privé, ouvre `http://<ip-machine-studio>:3210`. Utilise l'adresse IP affichée plutôt qu'un nom de machine. Autorise les connexions entrantes de Node si le pare-feu le demande.

Tous les appareils connectés partagent la bibliothèque du serveur et peuvent générer de la musique. Le mode réseau n'a pas de connexion par compte et s'utilise sur un réseau privé de confiance. N'expose pas ces ports sur Internet. Par défaut, `npm start` reste accessible uniquement depuis l'ordinateur hôte.

### Moteur ACE-Step sur une autre machine

Dans cette configuration, Python doit aussi accepter les connexions réseau. Sur le Mac Apple Silicon qui héberge ton installation ACE-Step avec uv, arrête le serveur actuel avec Ctrl+C, puis lance depuis le dossier ACE-Step :

~~~bash
ACESTEP_LM_BACKEND=mlx uv run acestep-api --host 0.0.0.0 --port 8001
~~~

Pour le paquet officiel avec Python embarqué, remplace `HOST="127.0.0.1"` par `HOST="0.0.0.0"` dans `start_api_server_macos.sh`, puis relance ce script. Ce réglage est interne au script : préfixer son lancement avec une variable HOST ne le remplace pas. Voir le [lanceur macOS officiel](https://github.com/ace-step/ACE-Step-1.5/blob/main/start_api_server_macos.sh).

Sur la machine qui héberge l'interface, indique l'IP du moteur :

~~~bash
ACESTEP_API_URL=http://<ip-machine-moteur>:8001 npm run start:lan
~~~

Ces affectations de variables utilisent la syntaxe macOS/Linux. Dans PowerShell, définis `$env:ACESTEP_API_URL = "http://<ip-machine-moteur>:8001"` avant de lancer npm.

## Configuration

| Variable | Valeur par défaut | Rôle |
| --- | --- | --- |
| `ACESTEP_API_URL` | `http://127.0.0.1:8001` | Adresse de l'API ACE-Step |
| `ACESTEP_API_KEY` | Vide | Clé facultative du moteur, transmise uniquement par le serveur Node |
| `PORT` | `3210` | Port du studio |
| `HOST` | `127.0.0.1` | `0.0.0.0` pour le réseau, ou utilise `npm run start:lan` |

Définis les variables dans le terminal de lancement. Le studio ne charge pas automatiquement de fichier .env. Pour activer une clé API côté moteur, consulte la [documentation officielle d'authentification](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/API.md#1-authentication).

## Stockage et périmètre

Le dossier `.data/`, à côté du serveur, contient l'audio et les métadonnées. Sauvegarde ce dossier pour conserver la bibliothèque. Il est exclu de Git, comme les fichiers d'environnement. Les brouillons et préférences de langue restent dans le stockage local de chaque navigateur.

Le studio copie les morceaux terminés depuis ACE-Step vers sa bibliothèque. Les anciens résultats Gradio ne sont pas importés automatiquement. Un suivi mis en pause n'annule pas la génération sur le moteur. Utilise « Vérifier l'état » pour le reprendre. Avant leur copie, les résultats restent soumis à la politique de cache du moteur.

Cette préversion couvre uniquement la création d'instrumentaux à partir de texte. Remix, repaint, entraînement LoRA et assemblage de mixes d'une heure ne sont pas inclus. Le backend LM est MLX sur macOS et PyTorch ailleurs.

## Développement

~~~bash
npm test
~~~

Les tests couvrent la validation, l'envoi et le suivi des tâches, la copie et la lecture partielle de l'audio, les seeds renvoyées, la persistance, les erreurs du moteur et les contrôles d'hôte et d'origine en mode réseau. Ils ne téléchargent aucun modèle et ne génèrent pas de musique.

L'application utilise HTML, CSS et JavaScript côté navigateur avec un serveur Node.js. Les requêtes suivent ce chemin :

~~~text
Navigateur → serveur Node Afterboot → API REST officielle ACE-Step
~~~

Le serveur utilise `/release_task`, `/query_result`, `/health` et `/v1/audio`.

## Crédits et licence

La génération musicale repose sur [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5). Merci aux auteurs et contributeurs d'ACE-Step pour le moteur et sa [documentation API](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/API.md).

Afterboot Studio est un client indépendant, maintenu séparément d'ACE-Step, sans affiliation officielle. Cette interface est disponible sous [licence MIT](LICENSE). ACE-Step et ses modèles conservent leurs licences respectives. Consulte la [licence amont](https://github.com/ace-step/ACE-Step-1.5/blob/main/LICENSE) et les fiches des modèles avant utilisation.
