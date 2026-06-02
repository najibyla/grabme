function storeStream(tabId, entry, prioritize) {
  chrome.storage.local.get([`streams_${tabId}`], function(result) {
    let streams = result[`streams_${tabId}`] || [];
    if (streams.some(item => item.url === entry.url)) return;

    if (prioritize) {
      streams.unshift(entry);
    } else {
      streams.push(entry);
    }
    chrome.storage.local.set({ [`streams_${tabId}`]: streams });
    chrome.action.setBadgeText({ tabId: tabId, text: streams.length.toString() });
    chrome.action.setBadgeBackgroundColor({ color: "#28a745" });
  });
}

chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    const url = details.url;
    const tabId = details.tabId;
    if (tabId < 0) return;

    let typeLabel = "";
    let downloadUrl = url;
    const reqType = details.type; // "main_frame", "sub_frame", "xmlhttprequest", …

    // --- DETECTION YOUTUBE / SHORTS (navigation directe, main_frame) ---
    // Filet de sécurité : tabs.onUpdated peut rater la navigation SPA YouTube
    if (reqType === "main_frame" &&
        (url.includes("youtube.com/watch?") || url.includes("youtube.com/shorts/"))) {
      const ytId = extractYouTubeId(url);
      if (ytId) {
        const videoUrl = `https://www.youtube.com/watch?v=${ytId}`;
        const isShort  = url.includes("youtube.com/shorts/");
        const prefix   = isShort ? "▶️ SHORT" : "▶️ YOUTUBE";
        storeStream(tabId, { url: videoUrl, label: `${prefix} - ⏳` }, true);
        chrome.storage.local.set({ [`yt_pending_${tabId}`]: { videoUrl, prefix } });
      }
      return;
    }

    // --- DETECTION LOOM ---
    if (url.includes("loom.com")) {
      if (url.includes("mediaplaylist-video")) {
        const bitrateMatch = url.match(/bitrate(\d+)/);
        const quality = bitrateMatch ? ` (${bitrateMatch[1]}k)` : " HD";
        typeLabel = `🎬 LOOM - Vidéo${quality}`;
      } else if (url.includes("mediaplaylist-audio")) {
        typeLabel = "🎬 LOOM - Vidéo (3200k)";
        downloadUrl = url.replace("mediaplaylist-audio.m3u8", "mediaplaylist-video-bitrate3200.m3u8");
      } else if (url.includes(".mp4")) {
        typeLabel = "🎬 LOOM - Direct MP4";
      }
      if (typeLabel) {
        storeStream(tabId, { url: downloadUrl, label: typeLabel }, true);
      }
      return;
    }

    // --- DETECTION YOUTUBE EMBED ---
    if (url.includes("youtube.com/embed/")) {
      const match = url.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/);
      if (match) {
        downloadUrl = `https://www.youtube.com/watch?v=${match[1]}`;
        storeStream(tabId, { url: downloadUrl, label: "▶️ YOUTUBE - Vidéo Embed" }, true);
      }
      return;
    }

    // --- DETECTION VIMEO ---
    // Utilise le titre envoyé par content.js depuis l'iframe player.vimeo.com
    // (plus précis que le titre de l'onglet parent qui affiche le nom du site)
    if (url.includes("vimeocdn.com") && url.includes(".m3u8")) {
      // Ignorer les playlists I-frame-only (très bas débit, uniquement pour le seek)
      if (url.includes("iframe")) return;

      if (url.includes("/sep/audio/")) {
        // Associer l'URL audio au stream vidéo Vimeo le plus récent du même onglet
        const key = `streams_${tabId}`;
        chrome.storage.local.get([key], (result) => {
          const streams = result[key] || [];
          let updated = false;
          for (const s of streams) {
            if (s.label && s.label.includes("VIMEO") && !s.audioUrl) {
              s.audioUrl = url;
              updated = true;
              break;
            }
          }
          if (updated) chrome.storage.local.set({ [key]: streams });
        });
        return;
      }

      // Master ou variant vidéo — stocker avec audioUrl vide (sera rempli par /sep/audio/)
      const titleKey = `vimeo_current_title_${tabId}`;
      chrome.storage.local.get([titleKey], (result) => {
        const stored = result[titleKey];
        if (stored) {
          storeStream(tabId, { url, label: `🎬 VIMEO - ${stored}`, audioUrl: "" }, true);
        } else {
          chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) return;
            const videoTitle = (tab && tab.title)
              ? tab.title.replace(/ [-|–].+$/, "").trim()
              : "Vidéo";
            storeStream(tabId, { url, label: `🎬 VIMEO - ${videoTitle}`, audioUrl: "" }, true);
          });
        }
      });
      return;
    }

    // --- DETECTION SKOOL / AUTRES SITES m3u8 ---
    if (url.includes(".m3u8")) {
      if (url.toLowerCase().includes("master") || !url.toLowerCase().includes("rendition")) {
        typeLabel = "⭐ SKOOL NATIVE - Master Container";
      } else if (url.toLowerCase().includes("audio") || url.includes("TRACK=audio")) {
        typeLabel = "SKOOL - Audio Seul";
      } else {
        const match = url.match(/(2160|1440|1080|720|480|360|240|144)p/i);
        typeLabel = match ? `SKOOL - Vidéo ${match[1]}p` : "SKOOL - Sous-playlist";
      }
      const prioritize = typeLabel.includes("Master") || typeLabel.includes("Vidéo");
      storeStream(tabId, { url: downloadUrl, label: typeLabel }, prioritize);
    }
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onRemoved.addListener(function(tabId) {
  chrome.storage.local.remove([
    `streams_${tabId}`,
    `vimeo_playlist_${tabId}`,
    `vimeo_current_title_${tabId}`,
    `yt_pending_${tabId}`
  ]);
});

function extractYouTubeId(url) {
  let m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  m = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

chrome.tabs.onUpdated.addListener(function(tabId, changeInfo) {
  // --- Changement d'URL : navigation vers une nouvelle page ---
  if (changeInfo.url) {
    chrome.storage.local.remove([
      `streams_${tabId}`,
      `vimeo_playlist_${tabId}`,
      `vimeo_current_title_${tabId}`,
      `yt_pending_${tabId}`
    ]);
    chrome.action.setBadgeText({ tabId: tabId, text: "" });

    const ytId = extractYouTubeId(changeInfo.url);
    if (ytId && (changeInfo.url.includes("youtube.com/watch") ||
                 changeInfo.url.includes("youtu.be/") ||
                 changeInfo.url.includes("youtube.com/shorts/"))) {
      const videoUrl = `https://www.youtube.com/watch?v=${ytId}`;
      const isShort  = changeInfo.url.includes("youtube.com/shorts/");
      const prefix   = isShort ? "▶️ SHORT" : "▶️ YOUTUBE";

      // Enregistrer immédiatement — pas de setTimeout (non fiable en MV3 service worker)
      // Le titre "⏳" sera mis à jour dès que changeInfo.title arrive
      storeStream(tabId, { url: videoUrl, label: `${prefix} - ⏳` }, true);
      chrome.storage.local.set({ [`yt_pending_${tabId}`]: { videoUrl, prefix } });
    }
  }

  // --- Mise à jour du titre de l'onglet → compléter le label YouTube ---
  if (changeInfo.title) {
    chrome.storage.local.get([`yt_pending_${tabId}`], (result) => {
      const pending = result[`yt_pending_${tabId}`];
      if (!pending) return;

      const cleanTitle = changeInfo.title.replace(/ [-–|] YouTube$/, "").trim();
      if (!cleanTitle || cleanTitle.toLowerCase() === "youtube") return;

      const streamsKey = `streams_${tabId}`;
      chrome.storage.local.get([streamsKey], (res) => {
        const streams = res[streamsKey] || [];
        let updated = false;
        for (const s of streams) {
          if (s.url === pending.videoUrl) {
            s.label  = `${pending.prefix} - ${cleanTitle}`;
            updated  = true;
            break;
          }
        }
        if (updated) {
          chrome.storage.local.set({ [streamsKey]: streams });
          chrome.storage.local.remove([`yt_pending_${tabId}`]);
        }
      });
    });
  }
});

// -----------------------------------------------------------------------
// Suivi de téléchargements hors popup (notifications + alarms)
// -----------------------------------------------------------------------
const POLL_ALARM = "grabme_poll_jobs";

chrome.alarms.onAlarm.addListener(function(alarm) {
  if (alarm.name !== POLL_ALARM) return;

  chrome.storage.local.get(["grabme_active_jobs"], (result) => {
    const jobs = result.grabme_active_jobs || {};
    if (Object.keys(jobs).length === 0) {
      chrome.alarms.clear(POLL_ALARM);
      return;
    }

    for (const [jobId, info] of Object.entries(jobs)) {
      fetch(`http://127.0.0.1:5000/status/${jobId}`)
        .then(r => r.json())
        .then(data => {
          if (data.status === "done") {
            chrome.notifications.create({
              type: "basic",
              iconUrl: "icon.png",
              title: "GrabMe — Téléchargement terminé",
              message: data.filename || info.title
            });
            delete jobs[jobId];
            chrome.storage.local.set({ grabme_active_jobs: jobs });
          } else if (data.status === "error") {
            chrome.notifications.create({
              type: "basic",
              iconUrl: "icon.png",
              title: "GrabMe — Erreur",
              message: `${info.title}: ${data.message}`
            });
            delete jobs[jobId];
            chrome.storage.local.set({ grabme_active_jobs: jobs });
          } else if (data.status === "unknown") {
            // Job disparu du serveur (redémarrage) — nettoyer
            delete jobs[jobId];
            chrome.storage.local.set({ grabme_active_jobs: jobs });
          }
        })
        .catch(() => { /* serveur injoignable — réessayer à la prochaine alarme */ });
    }
  });
});

chrome.runtime.onMessage.addListener(function(msg, sender) {
  // trackJob peut venir du popup (sender.tab peut être null si popup)
  if (msg.action === "trackJob" && msg.jobId) {
    chrome.storage.local.get(["grabme_active_jobs"], (result) => {
      const jobs = result.grabme_active_jobs || {};
      jobs[msg.jobId] = { title: msg.title || "Vidéo" };
      chrome.storage.local.set({ grabme_active_jobs: jobs });
      // Démarrer l'alarme de polling toutes les 10 secondes
      chrome.alarms.get(POLL_ALARM, (existing) => {
        if (!existing) {
          chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 / 6 });
        }
      });
    });
    return;
  }

  if (!sender.tab) return;
  const tabId = sender.tab.id;

  // Titre de la vidéo courante envoyé depuis l'iframe player.vimeo.com
  if (msg.action === "vimeoFrameTitle") {
    // Ignorer les titres internes Vimeo (proxy localStorage, pages utilitaires)
    const badTitles = ["vimeo player localstorage proxy", "localstorage proxy", "vimeo", "player", "untitled"];
    if (badTitles.includes(msg.title.toLowerCase())) return;
    chrome.storage.local.set({ [`vimeo_current_title_${tabId}`]: msg.title });

    // Mettre à jour le label du stream Vimeo le plus récent si déjà capturé
    const key = `streams_${tabId}`;
    chrome.storage.local.get([key], (result) => {
      const streams = result[key] || [];
      let updated = false;
      for (const s of streams) {
        if (s.url.includes("vimeocdn.com") && s.label.includes("VIMEO - ")) {
          const existingTitle = s.label.replace("🎬 VIMEO - ", "");
          if (existingTitle !== msg.title) {
            s.label = `🎬 VIMEO - ${msg.title}`;
            updated = true;
          }
          break;
        }
      }
      if (updated) chrome.storage.local.set({ [key]: streams });
    });
  }

  if (msg.action === "vimeoPlaylistTitles") {
    chrome.storage.local.set({ [`vimeo_playlist_${tabId}`]: msg.titles });
  }

  // Fallback : postMessage depuis la page parente (sites qui exposent Vimeo.Hub)
  if (msg.action === "vimeoEvent" && ["play", "ready"].includes(msg.event)) {
    const pageTitle = msg.pageTitle ? msg.pageTitle.replace(/ [-|–|:].+$/, "").trim() : null;
    if (!pageTitle) return;
    const key = `streams_${tabId}`;
    chrome.storage.local.get([key], (result) => {
      const streams = result[key] || [];
      let updated = false;
      for (const s of streams) {
        if (s.url.includes("vimeocdn.com")) {
          s.label = `🎬 VIMEO - ${pageTitle}`;
          updated = true;
          break;
        }
      }
      if (updated) chrome.storage.local.set({ [key]: streams });
    });
  }
});
