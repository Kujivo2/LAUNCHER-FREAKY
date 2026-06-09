const statusBadge = document.getElementById('statusBadge')
const launcherVersion = document.getElementById('launcherVersion')
const currentVersion = document.getElementById('currentVersion')
const currentLoader = document.getElementById('currentLoader')
const lastPublish = document.getElementById('lastPublish')
const publicManifest = document.getElementById('publicManifest')
const adminMessage = document.getElementById('adminMessage')
const resultBox = document.getElementById('result')
const fullModpackForm = document.getElementById('fullModpackForm')
const modsUpdateForm = document.getElementById('modsUpdateForm')
const launcherVersionForm = document.getElementById('launcherVersionForm')

async function readResponse(response) {
    const data = await response.json()
    if(!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`)
    }
    return data
}

function setBusy(form, busy, label) {
    const button = form.querySelector('button')
    form.querySelectorAll('input, button').forEach(input => {
        input.disabled = busy
    })
    if(busy) {
        button.dataset.originalText = button.textContent
        button.textContent = label
    } else if(button.dataset.originalText != null) {
        button.textContent = button.dataset.originalText
        delete button.dataset.originalText
    }
}

function showResult(data) {
    resultBox.textContent = JSON.stringify(data, null, 4)
}

function showMessage(message, type = 'info') {
    adminMessage.textContent = message
    adminMessage.dataset.type = type
}

function formatDate(value) {
    if(value == null) {
        return '-'
    }
    const date = new Date(value)
    if(Number.isNaN(date.getTime())) {
        return value
    }
    return date.toLocaleString('fr-FR')
}

async function refreshStatus() {
    const data = await readResponse(await fetch('/admin/status'))
    const manifest = data.manifest
    const draft = data.draft || {}
    const launcherInfo = data.launcherInfo

    launcherVersion.textContent = launcherInfo?.launcher?.version || 'v2.2.1'
    currentVersion.textContent = manifest?.version || 'Aucune'
    currentLoader.textContent = manifest == null
        ? 'Aucune publication'
        : `${manifest.minecraftVersion} / ${manifest.loader}${manifest.loaderVersion ? ` ${manifest.loaderVersion}` : ''}`
    lastPublish.textContent = formatDate(draft.publishedAt)
    publicManifest.textContent = data.publicBaseUrl ? `${data.publicBaseUrl}/manifest.json` : 'manifest.json'
    statusBadge.textContent = draft.dirty ? 'Modifications non publiees' : 'Pret'
    statusBadge.dataset.state = draft.dirty ? 'dirty' : 'ready'
}

async function submitForm(form, endpoint, busyLabel) {
    setBusy(form, true, busyLabel)
    showMessage('Publication en cours...', 'info')
    resultBox.textContent = ''

    try {
        const data = await readResponse(await fetch(endpoint, {
            method: 'POST',
            body: new FormData(form)
        }))
        showResult(data)
        showMessage(data.message || 'Publication terminee.', 'success')
        form.reset()
        await refreshStatus()
    } catch(err) {
        showResult({
            error: err.message
        })
        showMessage(err.message, 'error')
    } finally {
        setBusy(form, false)
    }
}

fullModpackForm.addEventListener('submit', event => {
    event.preventDefault()
    submitForm(fullModpackForm, '/admin/publish-full', 'Publication...')
})

modsUpdateForm.addEventListener('submit', event => {
    event.preventDefault()
    submitForm(modsUpdateForm, '/admin/publish-mods', 'Mise a jour...')
})

launcherVersionForm.addEventListener('submit', event => {
    event.preventDefault()
    submitForm(launcherVersionForm, '/admin/publish-launcher-info', 'Publication...')
})

refreshStatus().catch(err => {
    showMessage(err.message, 'error')
    showResult({
        error: err.message
    })
})
