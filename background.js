// Stocke un stream dans chrome.storage pour le tabId donné
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

    // --- DETECTION LOOM ---
    if (url.includes("loom.com")) {
      if (url.includes("mediaplaylist-video")) {
        const bitrateMatch = url.match(/bitrate(\d+)/);
        const quality = bitrateMatch ? ` (${bitrateMatch[1]}k)` : " HD";
        typeLabel = `🎬 LOOM - Vidéo${quality}`;
      } else if (url.includes("mediaplaylist-audio")) {
        // La vidéo peut être en cache — on dérive l'URL vidéo depuis l'audio
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
    if (url.includes("vimeocdn.com") && url.includes(".m3u8")) {
      // On récupère le titre de l'onglet au moment où la requête est faite
      // = titre de la vidéo en cours de lecture
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        const videoTitle = (tab && tab.title) ? tab.title.replace(/ [-|–].+$/, "").trim() : "Vidéo";
        storeStream(tabId, { url, label: `🎬 VIMEO - ${videoTitle}` }, true);
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
  chrome.storage.local.remove([`streams_${tabId}`]);
});

// Efface les streams uniquement lors d'un vrai changement d'URL (navigation)
// changeInfo.url est absent pour les rechargements d'iframes ou sous-ressources
chrome.tabs.onUpdated.addListener(function(tabId, changeInfo) {
  if (changeInfo.url) {
    chrome.storage.local.remove([`streams_${tabId}`]);
    chrome.action.setBadgeText({ tabId: tabId, text: "" });
  }
});

// Reçoit les titres de playlist extraits par content.js
chrome.runtime.onMessage.addListener(function(msg, sender) {
  if (msg.action === "vimeoPlaylistTitles" && sender.tab) {
    chrome.storage.local.set({ [`vimeo_playlist_${sender.tab.id}`]: msg.titles });
  }
});
