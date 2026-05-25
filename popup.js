let currentTab = null;
const activeJobs = new Map(); // url -> EventSource en cours

function renderStreams(streams) {
  const listContainer = document.getElementById("stream-list");
  const clearBtn = document.getElementById("clear-btn");

  if (streams.length === 0) {
    listContainer.innerHTML = '<p class="no-streams">Aucune vidéo détectée. Lancez la lecture pour capturer.</p>';
    clearBtn.style.display = "none";
    return;
  }

  clearBtn.style.display = "inline-block";
  listContainer.innerHTML = "";

  streams.forEach((streamObj, index) => {
    const item = document.createElement("div");
    item.className = "stream-item";

    let badgeColor = "#007bff";
    if (streamObj.label.includes("LOOM")) {
      badgeColor = "#6200ee";
    } else if (streamObj.label.includes("YOUTUBE")) {
      badgeColor = "#ff0000";
    } else if (streamObj.label.includes("⭐")) {
      badgeColor = "#ffc107";
    }

    item.innerHTML = `
      <div style="margin-bottom: 8px;">
        <span style="background: ${badgeColor}; color: ${badgeColor === '#ffc107' ? '#000' : '#fff'}; padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 11px; display: inline-block;">
          ${streamObj.label}
        </span>
      </div>
      <button id="copy-${index}" style="padding: 6px 12px; background: #f8f9fa; color: #333; border: 1px solid #ccc; border-radius: 4px; cursor: pointer; font-weight: 500;">Copy URL</button>
      <button id="download-${index}" style="padding: 6px 12px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer; margin-left: 6px; font-weight: bold;">Download</button>
      <div id="status-${index}" style="margin-top: 6px; font-size: 12px; color: #666; min-height: 16px;"></div>
    `;
    listContainer.appendChild(item);

    document.getElementById(`copy-${index}`).addEventListener("click", () => {
      navigator.clipboard.writeText(streamObj.url).then(() => {
        document.getElementById(`copy-${index}`).innerText = "Copied!";
      });
    });

    const downloadBtn = document.getElementById(`download-${index}`);

    // Restaurer l'état si ce stream est déjà en cours de téléchargement
    if (activeJobs.has(streamObj.url)) {
      downloadBtn.disabled = true;
      const statusDiv = document.getElementById(`status-${index}`);
      statusDiv.innerText = "⏳ Téléchargement en cours...";
      statusDiv.style.color = "#666";
    }

    downloadBtn.addEventListener("click", () => {
      if (activeJobs.has(streamObj.url)) return; // protection double-clic
      const statusDiv = document.getElementById(`status-${index}`);
      downloadBtn.disabled = true;
      statusDiv.style.color = "#666";
      statusDiv.innerText = "⏳ Connexion au serveur...";

      fetch("http://127.0.0.1:5000/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: streamObj.url, title: currentTab.title })
      })
      .then(res => res.json())
      .then(data => {
        if (!data.job_id) {
          statusDiv.innerText = "❌ " + (data.message || "Erreur inconnue");
          statusDiv.style.color = "#dc3545";
          downloadBtn.disabled = false;
          return;
        }

        const evtSource = new EventSource(`http://127.0.0.1:5000/progress/${data.job_id}`);
        activeJobs.set(streamObj.url, evtSource);

        evtSource.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === "ping") return;

          if (msg.type === "progress") {
            if (msg.percent !== undefined) {
              statusDiv.innerText = `⏳ ${msg.percent}%`;
            } else if (msg.label && msg.time) {
              statusDiv.innerText = `⏳ ${msg.label} — ${msg.time}`;
            } else if (msg.label) {
              statusDiv.innerText = `⏳ ${msg.label}`;
            } else if (msg.time) {
              statusDiv.innerText = `⏳ ${msg.time}`;
            }
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
          statusDiv.innerText = "❌ Connexion au serveur perdue";
          statusDiv.style.color = "#dc3545";
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
    });
  });
}

chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
  currentTab = tabs[0];

  chrome.storage.local.get([`streams_${currentTab.id}`], function(result) {
    renderStreams(result[`streams_${currentTab.id}`] || []);
  });

  // Rafraîchissement automatique — bloqué si des téléchargements sont en cours
  // (re-render détruirait les EventSource et réactiverait les boutons actifs)
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
});
