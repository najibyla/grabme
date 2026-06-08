let currentTab = null;
const activeJobs = new Map(); // url -> EventSource en cours
let currentStreams = [];

function titleFromStream(streamObj) {
  const m = streamObj.label.match(/(?:VIMEO|YOUTUBE|LOOM|SHORT)\s*-\s*(.+)$/i);
  if (m) {
    const extracted = m[1].trim();
    if (!/^(vidéo|video|direct|embed|native|sous-playlist|audio|master|short)/i.test(extracted)) {
      return extracted;
    }
  }
  return currentTab ? currentTab.title : "video";
}

function startDownload(streamObj, index, formatValue, audioUrlFromQuality) {
  if (activeJobs.has(streamObj.url)) return;

  const statusDiv   = document.getElementById(`status-${index}`);
  const downloadBtn = document.getElementById(`download-${index}`);
  if (!statusDiv || !downloadBtn) return;

  downloadBtn.disabled = true;
  statusDiv.style.color = "#666";
  statusDiv.innerText = "⏳ Connexion au serveur...";

  const panel = document.getElementById(`quality-panel-${index}`);
  if (panel) panel.style.display = "none";

  // Relire depuis le storage pour obtenir l'audioUrl le plus récent
  // (background.js peut l'avoir ajouté après le render du popup)
  const streamsKey = `streams_${currentTab.id}`;
  chrome.storage.local.get([streamsKey], (result) => {
    const fresh = (result[streamsKey] || []).find(s => s.url === streamObj.url);
    // Priorité : audioUrl du bouton qualité > audioUrl stocké en temps réel > fallback stream
    const audioUrl = audioUrlFromQuality
      || (fresh && fresh.audioUrl)
      || streamObj.audioUrl
      || "";

    fetch("http://127.0.0.1:5000/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: streamObj.url,
        title: titleFromStream(streamObj),
        format: formatValue || "",
        audioUrl,
        referer: (fresh && fresh.referer) || streamObj.referer || ""
      })
    })
  .then(res => res.json())
  .then(data => {
    if (!data.job_id) {
      statusDiv.innerText = "❌ " + (data.message || "Erreur inconnue");
      statusDiv.style.color = "#dc3545";
      downloadBtn.disabled = false;
      return;
    }

    chrome.runtime.sendMessage({ action: "trackJob", jobId: data.job_id, title: titleFromStream(streamObj) });

    const evtSource = new EventSource(`http://127.0.0.1:5000/progress/${data.job_id}`);
    activeJobs.set(streamObj.url, evtSource);

    evtSource.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "ping") return;
      if (msg.type === "progress") {
        if (msg.percent !== undefined)       statusDiv.innerText = `⏳ ${msg.percent}%`;
        else if (msg.label && msg.time)      statusDiv.innerText = `⏳ ${msg.label} — ${msg.time}`;
        else if (msg.label)                  statusDiv.innerText = `⏳ ${msg.label}`;
        else if (msg.time)                   statusDiv.innerText = `⏳ ${msg.time}`;
      } else if (msg.type === "done") {
        statusDiv.innerText = `✅ ${msg.filename}`;
        statusDiv.style.color = "#28a745";
        evtSource.close();
        activeJobs.delete(streamObj.url);
        downloadBtn.disabled = false;
      } else if (msg.type === "error") {
        statusDiv.innerText = `❌ ${msg.message}`;
        statusDiv.style.color = "#dc3545";
        evtSource.close();
        activeJobs.delete(streamObj.url);
        downloadBtn.disabled = false;
      }
    };

    evtSource.onerror = () => {
      evtSource.close();
      activeJobs.delete(streamObj.url);
      downloadBtn.disabled = false;
    };
  })
    .catch(() => {
      statusDiv.innerText = "❌ Serveur Python éteint 🔌";
      statusDiv.style.color = "#dc3545";
      downloadBtn.disabled = false;
    });
  }); // fin chrome.storage.local.get
}

// Cache des qualités déjà chargées (url -> qualities[])
const qualityCache = new Map();

function loadQualities(streamObj, index) {
  const panel      = document.getElementById(`quality-panel-${index}`);
  const toggleBtn  = document.getElementById(`quality-toggle-${index}`);
  if (!panel) return;

  // Toggle visibility si déjà chargé
  if (panel.dataset.loaded === "1") {
    const visible = panel.style.display !== "none";
    panel.style.display = visible ? "none" : "block";
    toggleBtn.innerText = visible ? "▾ Qualités" : "▴ Qualités";
    return;
  }

  panel.style.display = "block";
  toggleBtn.innerText = "▴ Qualités";
  panel.innerHTML = '<span style="font-size:11px;color:#888;">⏳ Chargement des qualités...</span>';

  if (qualityCache.has(streamObj.url)) {
    renderQualityButtons(panel, streamObj, index, qualityCache.get(streamObj.url));
    return;
  }

  const refParam = streamObj.referer ? `&referer=${encodeURIComponent(streamObj.referer)}` : "";
  fetch(`http://127.0.0.1:5000/qualities?url=${encodeURIComponent(streamObj.url)}${refParam}`)
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        panel.innerHTML = `<span style="font-size:11px;color:#dc3545;">❌ ${data.error}</span>`;
        return;
      }
      qualityCache.set(streamObj.url, data.qualities);
      renderQualityButtons(panel, streamObj, index, data.qualities);
    })
    .catch(() => {
      panel.innerHTML = '<span style="font-size:11px;color:#dc3545;">❌ Serveur Python éteint 🔌</span>';
    });
}

function renderQualityButtons(panel, streamObj, index, qualities) {
  panel.dataset.loaded = "1";
  if (!qualities || qualities.length === 0) {
    panel.innerHTML = '<span style="font-size:11px;color:#888;">Aucune qualité disponible</span>';
    return;
  }

  panel.innerHTML = "";
  qualities.forEach(q => {
    const btn = document.createElement("button");
    btn.innerText = q.label;
    btn.style.cssText = "margin: 2px 4px 2px 0; padding: 4px 10px; font-size: 11px; border: 1px solid #1ab7ea; background: #fff; color: #1ab7ea; border-radius: 12px; cursor: pointer; font-weight: 600;";
    btn.addEventListener("mouseenter", () => { btn.style.background = "#1ab7ea"; btn.style.color = "#fff"; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "#fff"; btn.style.color = "#1ab7ea"; });
    btn.addEventListener("click", () => {
      startDownload(streamObj, index, q.value, q.audioUrl || "");
    });
    panel.appendChild(btn);
  });
}

function renderStreams(streams) {
  currentStreams = streams;
  const listContainer  = document.getElementById("stream-list");
  const clearBtn       = document.getElementById("clear-btn");
  const downloadAllBtn = document.getElementById("download-all-btn");

  if (streams.length === 0) {
    listContainer.innerHTML = '<p class="no-streams">Aucune vidéo détectée. Lancez la lecture pour capturer.</p>';
    clearBtn.style.display       = "none";
    downloadAllBtn.style.display = "none";
    return;
  }

  clearBtn.style.display       = "inline-block";
  downloadAllBtn.style.display = streams.length >= 2 ? "inline-block" : "none";
  listContainer.innerHTML = "";

  streams.forEach((streamObj, index) => {
    const item = document.createElement("div");
    item.className = "stream-item";

    let badgeColor = "#007bff";
    if (streamObj.label.includes("LOOM"))                                        badgeColor = "#6200ee";
    else if (streamObj.label.includes("YOUTUBE") || streamObj.label.includes("SHORT")) badgeColor = "#ff0000";
    else if (streamObj.label.includes("VIMEO"))                                  badgeColor = "#1ab7ea";
    else if (streamObj.label.includes("⭐"))                                      badgeColor = "#ffc107";

    item.innerHTML = `
      <div style="margin-bottom: 8px;">
        <span style="background:${badgeColor}; color:${badgeColor==='#ffc107'?'#000':'#fff'}; padding:4px 8px; border-radius:4px; font-weight:bold; font-size:11px; display:inline-block;">
          ${streamObj.label}
        </span>
      </div>
      <button id="copy-${index}" style="padding:6px 12px; background:#f8f9fa; color:#333; border:1px solid #ccc; border-radius:4px; cursor:pointer; font-weight:500;">Copy URL</button>
      <button id="download-${index}" style="padding:6px 12px; background:#28a745; color:#fff; border:none; border-radius:4px; cursor:pointer; margin-left:6px; font-weight:bold;">⬇ Meilleure</button>
      <button id="quality-toggle-${index}" style="padding:6px 10px; background:#fff; color:#555; border:1px solid #ccc; border-radius:4px; cursor:pointer; margin-left:4px; font-size:12px;">▾ Qualités</button>
      <div id="quality-panel-${index}" style="display:none; margin-top:6px; padding:6px; background:#f8f9fa; border-radius:4px; border:1px solid #e9ecef;"></div>
      <div id="status-${index}" style="margin-top:6px; font-size:12px; color:#666; min-height:16px;"></div>
    `;
    listContainer.appendChild(item);

    document.getElementById(`copy-${index}`).addEventListener("click", () => {
      navigator.clipboard.writeText(streamObj.url).then(() => {
        document.getElementById(`copy-${index}`).innerText = "Copied!";
      });
    });

    const downloadBtn = document.getElementById(`download-${index}`);
    if (activeJobs.has(streamObj.url)) {
      downloadBtn.disabled = true;
      document.getElementById(`status-${index}`).innerText = "⏳ Téléchargement en cours...";
    }

    downloadBtn.addEventListener("click", () => startDownload(streamObj, index, ""));
    document.getElementById(`quality-toggle-${index}`).addEventListener("click", () => loadQualities(streamObj, index));
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
  currentTab = tabs[0];

  chrome.storage.local.get([`streams_${currentTab.id}`], function(result) {
    renderStreams(result[`streams_${currentTab.id}`] || []);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && currentTab && changes[`streams_${currentTab.id}`]) {
      if (activeJobs.size === 0) {
        renderStreams(changes[`streams_${currentTab.id}`].newValue || []);
      }
    }
  });

  document.getElementById("clear-btn").addEventListener("click", () => {
    chrome.storage.local.remove([`streams_${currentTab.id}`]);
    chrome.action.setBadgeText({ tabId: currentTab.id, text: "" });
  });

  document.getElementById("download-all-btn").addEventListener("click", () => {
    currentStreams.forEach((streamObj, index) => {
      if (!activeJobs.has(streamObj.url)) startDownload(streamObj, index, "");
    });
  });
});
