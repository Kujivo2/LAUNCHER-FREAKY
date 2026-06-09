const statusBadge = document.getElementById('statusBadge')
const launcherVersion = document.getElementById('launcherVersion')
const launcherUpdateUrl = document.getElementById('launcherUpdateUrl')
const currentVersion = document.getElementById('currentVersion')
const currentLoader = document.getElementById('currentLoader')
const lastPublish = document.getElementById('lastPublish')
const publicManifest = document.getElementById('publicManifest')
const adminMessage = document.getElementById('adminMessage')
const resultBox = document.getElementById('result')
const modsList = document.getElementById('modsList')
const settingsForm = document.getElementById('settingsForm')
const addModsForm = document.getElementById('addModsForm')
const publishForm = document.getElementById('publishForm')
const launcherForm = document.getElementById('launcherForm')

async function readResponse(response) {
    const data = await response.json()
    if(!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`)
    }
    return data
}

function showMessage(message, type = 'info') {
    adminMessage.textContent = message
    adminMessage.dataset.type = type
}

function showResult(data) {
    resultBox.textContent = JSON.stringify(data, null, 4)
}

function formatDate(value) {
    const date = value == null ? null : new Date(value)
    return date == null || Number.isNaN(date.getTime()) ? '-' : date.toLocaleString('fr-FR')
}

function setBusy(form, busy, label) {
    const button = form.querySelector('button')
    form.querySelectorAll('input, select, button').forEach(element => {
        element.disabled = busy
    })
    if(busy) {
        button.dataset.label = button.textContent
        button.textContent = label
    } else if(button.dataset.label != null) {
        button.textContent = button.dataset.label
        delete button.dataset.label
    }
}

function fillSettings(data) {
    const draft = data.draft || {}
    const manifest = data.manifest || {}
    settingsForm.versionModpack.value = draft.version || manifest.version || ''
    settingsForm.versionLauncher.value = draft.launcherVersion || manifest.launcher?.version || ''
    settingsForm.minecraftVersion.value = draft.minecraftVersion || manifest.minecraftVersion || '1.20.1'
    settingsForm.loader.value = draft.loader || manifest.loader || 'fabric'
    settingsForm.loaderVersion.value = draft.loaderVersion || manifest.loaderVersion || ''
}

function renderMods(files) {
    const mods = files.filter(file => file.startsWith('mods/'))
    modsList.replaceChildren()
    if(mods.length === 0) {
        modsList.textContent = 'Aucun mod dans le brouillon.'
        return
    }
    for(const file of mods) {
        const row = document.createElement('div')
        row.className = 'fileRow'
        const name = document.createElement('span')
        name.textContent = file.substring('mods/'.length)
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = 'Supprimer'
        button.addEventListener('click', () => removeFile(file, button))
        row.append(name, button)
        modsList.append(row)
    }
}

async function refreshStatus() {
    const data = await readResponse(await fetch('/admin/status', { cache: 'no-store' }))
    const manifest = data.manifest
    const draft = data.draft || {}
    launcherVersion.textContent = manifest?.launcher?.version || draft.launcherVersion || '-'
    launcherUpdateUrl.textContent = manifest?.launcher?.updateUrl || `${data.publicBaseUrl}/launcher`
    currentVersion.textContent = manifest?.version || 'Aucune'
    currentLoader.textContent = manifest == null
        ? 'Aucune publication'
        : `${manifest.minecraftVersion} / ${manifest.loader}${manifest.loaderVersion ? ` ${manifest.loaderVersion}` : ''}`
    lastPublish.textContent = formatDate(draft.publishedAt)
    publicManifest.textContent = `${data.publicBaseUrl}/manifest.json`
    statusBadge.textContent = draft.dirty ? 'Modifications non publiees' : 'Pret'
    statusBadge.dataset.state = draft.dirty ? 'dirty' : 'ready'
    fillSettings(data)
    renderMods(data.files || [])
}

async function submitForm(form, endpoint, label, useJson = false) {
    setBusy(form, true, label)
    showMessage('Operation en cours...')
    try {
        const options = {
            method: 'POST'
        }
        if(useJson) {
            options.headers = {
                'Content-Type': 'application/json'
            }
            options.body = JSON.stringify(Object.fromEntries(new FormData(form)))
        } else {
            options.body = new FormData(form)
        }
        const data = await readResponse(await fetch(endpoint, options))
        showResult(data)
        showMessage(data.message || 'Operation terminee.', 'success')
        await refreshStatus()
        if(form === addModsForm || form === launcherForm) {
            form.reset()
        }
    } catch(err) {
        showResult({
            error: err.message
        })
        showMessage(err.message, 'error')
    } finally {
        setBusy(form, false)
    }
}

async function removeFile(file, button) {
    button.disabled = true
    try {
        const data = await readResponse(await fetch('/admin/remove-file', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                path: file
            })
        }))
        showResult(data)
        showMessage(`${file} supprime du brouillon.`, 'success')
        await refreshStatus()
    } catch(err) {
        showMessage(err.message, 'error')
        button.disabled = false
    }
}

settingsForm.addEventListener('submit', event => {
    event.preventDefault()
    submitForm(settingsForm, '/admin/settings', 'Enregistrement...', true)
})

addModsForm.addEventListener('submit', event => {
    event.preventDefault()
    submitForm(addModsForm, '/admin/add-mods', 'Ajout...')
})

publishForm.addEventListener('submit', event => {
    event.preventDefault()
    submitForm(publishForm, '/admin/publish', 'Publication...', true)
})

launcherForm.addEventListener('submit', event => {
    event.preventDefault()
    submitForm(launcherForm, '/admin/publish-launcher', 'Publication...')
})

refreshStatus().catch(err => {
    showMessage(err.message, 'error')
    showResult({
        error: err.message
    })
})
