# Khaeris manifest modpack flow

Khaeris now uses a small web manifest for modpack installation and keeps the
Helios local profile code for Minecraft, Fabric, Forge, Java, and process
launching.

## Local web layout

The admin server writes to this XAMPP folder by default:

```text
C:\xampp\htdocs\khaeris\
|-- api\
|   `-- draft.json
|-- admin\
|-- launcher\
|-- manifest.json
|-- modpacks\
|   `-- khaeris-fabric-1.20.1\
|       |-- base.zip
|       |-- mods\
|       |-- config\
|       `-- resourcepacks\
`-- uploads\
    `-- khaeris-fabric-1.20.1-draft\
```

Apache can serve the published manifest at:

```text
http://localhost/khaeris/manifest.json
```

The Node admin panel runs separately. Imports, additions, and removals first
change the draft folder under `uploads/`; only `Publier` replaces the public
files under `modpacks/` and writes a new `manifest.json`:

```powershell
npm install
npm run admin:start
```

Open:

```text
http://localhost:3030/admin/
```

## Environment values

The defaults target XAMPP on Windows:

```powershell
$env:KHAERIS_WEB_ROOT = 'C:\xampp\htdocs\khaeris'
$env:KHAERIS_PUBLIC_BASE_URL = 'http://localhost/khaeris'
$env:KHAERIS_ADMIN_PORT = '3030'
npm run admin:start
```

The launcher reads:

```text
http://localhost/khaeris/manifest.json
```

Override that for a VPS or test server with `KHAERIS_MANIFEST_URL` before
starting Electron.

## Published manifest

The panel generates this format:

```json
{
    "modpackId": "khaeris-fabric-1.20.1",
    "version": "0.0.5",
    "minecraftVersion": "1.20.1",
    "loader": "fabric",
    "loaderVersion": "0.19.2",
    "baseZip": "http://localhost/khaeris/modpacks/khaeris-fabric-1.20.1/base.zip",
    "baseZipSha256": "sha256-generated-by-admin",
    "baseZipSize": 123456,
    "files": [
        {
            "path": "mods/example.jar",
            "url": "http://localhost/khaeris/modpacks/khaeris-fabric-1.20.1/mods/example.jar",
            "sha256": "sha256-generated-by-admin",
            "size": 12345
        }
    ]
}
```

Every published file has a SHA256 and byte size. The launcher uses `base.zip`
for a first install, then verifies and updates individual manifest files.

## ZIP upload

`POST /admin/upload-basezip` replaces the draft pack content.

The upload accepts:

- a normalized ZIP containing `mods/`, `config/`, and `resourcepacks/`;
- a CurseForge-style ZIP with `manifest.json` and `overrides/`.

The supplied Khaeris Fabric `1.20.1-0.0.5` archive is a CurseForge-style ZIP:
its internal manifest declares Minecraft `1.20.1`, loader
`fabric-0.19.2`, `overrides/`, and external CurseForge file IDs. The admin
server extracts the override files and mirrors those CurseForge mod downloads
into `modpacks/khaeris-fabric-1.20.1/mods/` before publishing.

## Admin routes

```text
GET    /manifest.json
POST   /admin/upload-basezip
POST   /admin/add-file
DELETE /admin/remove-file
POST   /admin/publish
```

`POST /admin/add-file` accepts a multipart field `file` and optional `path`.
The path must stay under `mods/`, `config/`, or `resourcepacks/`.

`DELETE /admin/remove-file` accepts JSON:

```json
{
    "path": "mods/old-mod.jar"
}
```

`POST /admin/publish` accepts an optional version:

```json
{
    "version": "0.0.6"
}
```

If the version is omitted, an existing published patch version is incremented.

## Launcher behavior

When the player clicks Play:

1. the launcher selects the built-in Khaeris local profile;
2. it downloads `manifest.json`;
3. if local `version.json` is absent or loader metadata changed, it downloads
   and extracts `base.zip`;
4. it checks every published file SHA256 and size;
5. it downloads missing or changed files one by one;
6. it removes old files which were present in the previous local
   `version.json` but are no longer in the manifest;
7. Helios local profile code downloads Minecraft or loader runtime files when
   needed and starts Minecraft.

The instance contains:

```text
instances\khaeris-fabric-1.20.1\
|-- version.json
|-- mods\
|-- config\
`-- resourcepacks\
```

## Files in this repo

- `app/assets/js/simplemodpackmanager.js` installs `base.zip`, verifies files,
  writes local `version.json`, and performs file updates.
- `app/assets/js/scripts/landing.js` runs the modpack update before the local
  profile launch path.
- `app/assets/js/distromanager.js` keeps a tiny local Helios bootstrap object
  for existing UI screens instead of fetching a remote distribution.
- `web-admin/server.js` provides the Express admin API and manifest generator.
- `web-admin/public/` contains the local admin panel.
