# Architecture simple du launcher Khaeris

Le projet utilise Electron pour l'interface, Helios Core pour telecharger et
lancer Minecraft, et un unique `manifest.json` pour decrire le modpack et la
version distante du launcher.

## Demarrage du launcher

1. `package.json` lance `index.js`.
2. `index.js` cree la fenetre Electron et charge `app/app.ejs`.
3. `app/assets/js/preloader.js` charge la configuration locale et la facade de
   distribution.
4. `app/assets/js/distromanager.js` cree un profil Minecraft local minimal.
5. Le bouton `JOUER` appelle `SimpleModpackManager.syncModpack()`.
6. Le launcher synchronise le modpack, valide Java et les fichiers Minecraft,
   puis `ProcessBuilder` demarre le processus Java.

## Synchronisation du modpack

Le fichier `app/assets/js/simplemodpackmanager.js`:

- telecharge `manifest.json`;
- installe `base.zip` lors de la premiere installation ou d'un changement de
  version Minecraft/loader;
- compare la taille et le SHA-256 de chaque fichier;
- telecharge uniquement les fichiers absents ou modifies;
- supprime les fichiers presents dans l'ancien `version.json` mais absents du
  nouveau manifest;
- ecrit le nouvel etat local dans
  `instances/<modpackId>/version.json`.

Seuls `mods/`, `config/` et `resourcepacks/` sont geres automatiquement. Les
mondes, captures d'ecran et options personnelles ne sont jamais supprimes.

## Structure web publique

```text
khaeris/
|-- manifest.json
|-- news.json
|-- launcher-info.json
|-- launcher/
|   |-- latest.yml
|   |-- Khaeris Launcher-setup-2.2.2.exe
|   `-- Khaeris Launcher-setup-2.2.2.exe.blockmap
`-- modpacks/
    `-- khaeris-fabric-1.20.1/
        |-- base.zip
        |-- mods/
        |-- config/
        `-- resourcepacks/
```

Apache, Nginx, GitHub Pages ou un stockage objet peuvent servir ces fichiers.
Le panel Node est necessaire uniquement pour administrer et publier.

## Configuration

Les valeurs par defaut ciblent XAMPP:

```powershell
$env:KHAERIS_WEB_ROOT = 'C:\xampp\htdocs\khaeris'
$env:KHAERIS_PUBLIC_BASE_URL = 'http://localhost/khaeris'
$env:KHAERIS_ADMIN_PORT = '3030'
npm.cmd run admin:start
```

Le launcher utilise la meme base publique. En developpement:

```powershell
$env:KHAERIS_PUBLIC_BASE_URL = 'https://launcher.exemple.fr'
npm.cmd start
```

Pour une application distribuee, remplacer aussi l'URL `publish.url` dans
`electron-builder.yml` avant le build.

## Format du manifest

```json
{
    "modpackId": "khaeris-fabric-1.20.1",
    "version": "1.0.1",
    "minecraftVersion": "1.20.1",
    "loader": "fabric",
    "loaderVersion": "0.19.2",
    "baseZip": "https://launcher.exemple.fr/modpacks/khaeris-fabric-1.20.1/base.zip",
    "baseZipSha256": "...",
    "baseZipSize": 123456,
    "launcher": {
        "version": "v2.2.2",
        "updateUrl": "https://launcher.exemple.fr/launcher"
    },
    "files": [
        {
            "path": "mods/example.jar",
            "url": "https://launcher.exemple.fr/modpacks/khaeris-fabric-1.20.1/mods/example.jar",
            "sha256": "...",
            "size": 12345
        }
    ]
}
```

## Panel administrateur

Demarrer le panel:

```powershell
npm.cmd run admin:start
```

Ouvrir `http://localhost:3030/admin/`.

Le panel permet de:

- ajouter plusieurs mods au brouillon;
- supprimer un mod du brouillon;
- modifier les versions du modpack, du launcher, de Minecraft et du loader;
- publier le modpack et regenerer tous les hashes;
- publier les artefacts de mise a jour du launcher.

Le bouton `Publier le modpack` copie le brouillon dans le dossier public,
reconstruit `base.zip`, puis ecrit `manifest.json`. Un mod supprime disparait
du manifest et sera donc supprime chez les joueurs.

## Mise a jour du launcher

1. Modifier la version dans `package.json`.
2. Configurer `publish.url` dans `electron-builder.yml`.
3. Executer `npm.cmd run dist:win`.
4. Dans le panel, selectionner `latest.yml`, l'installateur `.exe` et le
   `.blockmap` produits dans `dist/`.
5. Publier avec la meme version que `package.json`.

Au demarrage, le launcher compare `manifest.launcher.version` avec sa version
installee. Si la version distante est plus recente, `electron-updater`
telecharge les artefacts du dossier public `/launcher`.
