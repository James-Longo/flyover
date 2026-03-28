/**
 * BirdFeed Application Logic
 */

document.addEventListener('DOMContentLoaded', () => {
    const apiInput = document.getElementById('api-key-input');
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const loginScreen = document.getElementById('login-screen');
    const feedScreen = document.getElementById('feed-screen');
    const feedItems = document.getElementById('feed-items');
    const regionSelect = document.createElement('div'); // Will inject into sidebar

    // Initialize state
    let currentRegion = localStorage.getItem('ebird_region') || 'US-ME-009'; // Default Hancock, ME
    let currentRegionName = localStorage.getItem('ebird_region_name') || 'Hancock, Maine';
    let currentCoords = { lat: 44.4759, lng: -68.4371 }; // Fallback
    let isLoadingMore = false;
    let lastLoadedDate = new Date();
    let scrollObserver = null;
    const galleryCache = new Map();
    const speciesCache = new Map();
    const seenIds = new Set(); // Track unique sightings to avoid UI ghosts

    // Shared Observer for lazy card content (Species & Media)
    const lazyObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const card = entry.target;
                
                const speciesEl = card.querySelector('.species-list');
                if (speciesEl) fetchAndRenderSpecies(speciesEl, speciesEl.dataset.source);

                const mediaEl = card.querySelector('.card-media');
                if (mediaEl) fetchAndRenderMedia(mediaEl, mediaEl.dataset.source);

                lazyObserver.unobserve(card);
            }
        });
    }, { rootMargin: '200px' });

    const savedKey = localStorage.getItem('ebird_api_key');
    if (savedKey) {
        login(savedKey);
    } else {
        loginScreen.classList.add('active'); // Only show if not logged in
    }

    // Event Listeners
    loginBtn.addEventListener('click', () => {
        const key = apiInput.value.trim();
        if (key) {
            login(key);
        } else {
            alert("Please enter a valid API key.");
        }
    });

    logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('ebird_api_key');
        window.location.reload();
    });

    // Global Media Click Handler (Event Delegation for instant response)
    feedItems.addEventListener('click', (e) => {
        const mediaCard = e.target.closest('.card-media');
        if (mediaCard) {
            openLightbox(mediaCard.id);
        }
    });

    async function login(key) {
        if (key) {
            localStorage.setItem('ebird_api_key', key);
            window.ebird.setApiKey(key);
        }

        loginScreen.classList.remove('active');
        feedScreen.classList.add('active');

        // Try to get location
        detectLocation();

        // Initial load
        loadFeed();
    }


    async function detectLocation() {
        if (!navigator.geolocation) return;

        navigator.geolocation.getCurrentPosition(async (position) => {
            const { latitude, longitude } = position.coords;
            currentCoords = { lat: latitude, lng: longitude };
            console.log("Location detected:", latitude, longitude);

            try {
                // 1. Reverse geocode to get county name/state
                const geoResp = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`);
                const geoData = await geoResp.json();
                const county = geoData.address.county || geoData.address.city;
                const state = geoData.address.state;
                
                if (county && state) {
                    currentRegionName = `${county}, ${state}`;
                    localStorage.setItem('ebird_region_name', currentRegionName);
                    
                    const foundRegion = await findEbirdRegion(county, state);
                    if (foundRegion) {
                        currentRegion = foundRegion;
                        localStorage.setItem('ebird_region', currentRegion);
                        loadFeed();
                    }
                }
            } catch (error) {
                console.warn("Reverse geocode failed:", error);
            }
        });
    }

    async function findEbirdRegion(countyName, stateName) {
        try {
            const stateCodes = { "Maine": "US-ME", "New York": "US-NY", "Massachusetts": "US-MA", "California": "US-CA" };
            const stateCode = stateCodes[stateName];
            if (!stateCode) return null;

            const regions = await window.ebird.fetchJson(`/ref/region/list/sub1/${stateCode}`);
            const cleanCounty = countyName.replace(' County', '');
            const match = regions.find(r => r.name.toLowerCase() === cleanCounty.toLowerCase());
            return match ? match.code : null;
        } catch (e) {
            return null;
        }
    }

    async function loadFeed() {
        feedItems.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Fetching from eBird & iNaturalist...</p></div>';
        lastLoadedDate = new Date(); // Reset date on reload
        clearInfiniteScroll(); // Remove old observers

        try {
            await window.ebird.loadTaxonomy(currentRegion);
            
            // Parallel Fetch
            const [ebirdData, inatData] = await Promise.all([
                window.ebird.getRecentChecklists(currentRegion),
                window.inat.fetchObservations(currentCoords.lat, currentCoords.lng, 20, lastLoadedDate)
            ]);

            // Normalize eBird sightings to match unified format
            const normalizedEbird = groupChecklists(ebirdData).map(list => {
                const dateStr = list.obsTime ? `${list.obsDt} ${list.obsTime}` : list.obsDt;
                return {
                    source: 'ebird',
                    id: list.subId,
                    date: new Date(dateStr.replace(/-/g, "/")),
                    ...list
                };
            });

            // Combine and Sort by Date
            // Combine, Sort, and Filter Duplicates
            const groupedInat = groupInatObservations(inatData);
            const combinedFeed = [...normalizedEbird, ...groupedInat]
                .filter(item => {
                    if (seenIds.has(item.id)) return false;
                    seenIds.add(item.id);
                    return true;
                })
                .sort((a, b) => b.date - a.date);
            
            // Pre-populate caches for instant loading
            combinedFeed.forEach(item => {
                if (item.source === 'inaturalist') {
                    galleryCache.set(`media-${item.id}`, item.media);
                    speciesCache.set(`species-${item.id}`, item.obs);
                }
            });

            renderFeed(combinedFeed, true); // True = overwrite

            setupInfiniteScroll();
            updateRegionalStats();
        } catch (error) {
            console.error("Feed load failed:", error);
            feedItems.innerHTML = `<div class="error-state">Error loading feed: ${error.message}</div>`;
        }
    }

    function groupChecklists(checklists) {
        const groups = new Map();
        checklists.forEach(list => {
            // Group by location, exact time, and species count (heuristic for shared checklists)
            const key = `${list.locId}_${list.isoObsDate}_${list.numSpecies}`;
            if (!groups.has(key)) {
                groups.set(key, { ...list, subIds: [list.subId], contributors: [list.userDisplayName] });
            } else {
                const group = groups.get(key);
                if (!group.contributors.includes(list.userDisplayName)) {
                    group.contributors.push(list.userDisplayName);
                    group.subIds.push(list.subId);
                }
            }
        });
        return Array.from(groups.values());
    }

    function groupInatObservations(observations) {
        const groups = new Map();
        observations.forEach(obs => {
            // Group by user and local date (avoiding UTC midnight slips)
            const y = obs.date.getFullYear();
            const m = String(obs.date.getMonth() + 1).padStart(2, '0');
            const d = String(obs.date.getDate()).padStart(2, '0');
            const dateStr = `${y}-${m}-${d}`; 
            const key = `inat_${obs.userDisplayName}_${dateStr}`.replace(/[^a-zA-Z0-9_-]/g, '_');
            
            if (!groups.has(key)) {
                // Initialize group with a deepish copy
                groups.set(key, { 
                    ...obs, 
                    id: key, 
                    obs: [...obs.obs], 
                    media: [...obs.media] 
                });
            } else {
                const group = groups.get(key);
                group.obs.push(...obs.obs);
                group.media.push(...obs.media);
                group.numSpecies = group.obs.length;
                
                // Keep the most recent timestamp and location from this session
                if (obs.date > group.date) {
                    group.date = obs.date;
                    group.obsDt = obs.obsDt;
                    group.locName = obs.locName;
                    group.loc = obs.loc;
                }
            }
        });
        return Array.from(groups.values());
    }

    async function updateRegionalStats() {
        try {
            // Stats should follow the currently detected county/region code
            const [ebirdStats, inatStats] = await Promise.all([
                window.ebird.getRegionalStats(currentRegion),
                window.inat.getDailyStats(currentCoords.lat, currentCoords.lng)
            ]);
            
            document.getElementById('stats-ebird-lists').innerText = ebirdStats.numChecklists || 0;
            document.getElementById('stats-ebird-species').innerText = ebirdStats.numSpecies || 0;
            document.getElementById('stats-inat-obs').innerText = inatStats.numObservations || 0;
            document.getElementById('stats-inat-species').innerText = inatStats.numSpecies || 0;

            const scopeText = document.getElementById('stats-scope-text');
            if (scopeText) {
                scopeText.innerText = `eBird: ${currentRegionName || 'Local County'} • iNat: 20km Radius`;
            }
        } catch (error) {
            console.warn("Failed to update regional stats:", error);
        }
    }

    async function renderFeed(checklists, overwrite = false) {
        if (overwrite) feedItems.innerHTML = '';

        if (checklists.length === 0 && overwrite) {
            feedItems.innerHTML = '<div class="empty-state">No recent checklists found in this region.</div>';
            return;
        }

        for (const list of checklists) {
            const card = document.createElement('div');
            card.className = 'checklist-card'; 

            const authors = list.contributors || [list.userDisplayName];
            const mainAuthor = authors[0];
            let authorText = mainAuthor;

            if (authors.length === 2) {
                authorText = `${mainAuthor} with ${authors[1]}`;
            } else if (authors.length > 2) {
                authorText = `${mainAuthor} with ${authors[1]} and ${authors.length - 2} others`;
            }

            const dateStr = list.date.toLocaleString([], {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit'
            });

            const isInat = list.source === 'inaturalist';

            card.innerHTML = `
                <div class="card-header">
                    <div class="checklist-meta">
                        <h4>${authorText}</h4>
                        <p>${dateStr} • <a href="https://www.google.com/maps/search/?api=1&query=${list.loc.latitude},${list.loc.longitude}" target="_blank" class="location-link">${list.locName}</a></p>
                    </div>
                </div>
                <div class="card-summary">
                    <div class="obs-count">
                        ${isInat ? 
                            `<span>🌿</span> ${list.numSpecies} Observation` : 
                            `<a href="https://ebird.org/checklist/${list.id}" target="_blank" style="color: inherit; text-decoration: none; display: flex; align-items: center; gap: 0.5rem;"><span>🐦</span> ${list.numSpecies} Species sighted</a>`}
                    </div>
                </div>
                <!-- Media/Photo Container -->
                <div class="card-media" id="media-${list.id}" data-id="${list.id}" data-source="${list.source}" data-subids='${JSON.stringify(list.subIds || [list.id])}'>
                </div>
                
                <div class="species-list" id="species-${list.id}" data-id="${list.id}" data-source="${list.source}">
                    <p style="font-size: 0.8rem; color: #999;">Loading highlights...</p>
                </div>
            `;
                
                feedItems.appendChild(card);
            }

        setupLazyContent();
    }

    function setupInfiniteScroll() {
        const sentinel = document.getElementById('load-more-sentinel');
        if (!sentinel) return;

        scrollObserver = new IntersectionObserver(async (entries) => {
            if (entries[0].isIntersecting && !isLoadingMore) {
                await loadMore();
            }
        }, { rootMargin: '400px' });

        scrollObserver.observe(sentinel);
    }

    function clearInfiniteScroll() {
        if (scrollObserver) {
            scrollObserver.disconnect();
            scrollObserver = null;
        }
    }

    async function loadMore() {
        if (isLoadingMore) return;
        isLoadingMore = true;

        let itemsFound = 0;
        let daysTried = 0;
        const MAX_DAYS = 7; // Safety cap to avoid infinite loops on empty regions

        try {
            while (itemsFound === 0 && daysTried < MAX_DAYS) {
                console.log(`Loading sightings for: ${lastLoadedDate.toDateString()}`);
                
                const [rawChecklists, inatData] = await Promise.all([
                    window.ebird.getRecentChecklists(currentRegion, lastLoadedDate),
                    window.inat.fetchObservations(currentCoords.lat, currentCoords.lng, 20, lastLoadedDate)
                ]);

                const normalizedEbird = groupChecklists(rawChecklists).map(list => {
                    const dateStr = list.obsTime ? `${list.obsDt} ${list.obsTime}` : list.obsDt;
                    return {
                        source: 'ebird',
                        id: list.subId,
                        date: new Date(dateStr.replace(/-/g, "/")),
                        ...list
                    };
                });

                const groupedInat = groupInatObservations(inatData);
                
                // Merge and filter
                const combinedFeed = [...normalizedEbird, ...groupedInat]
                    .filter(item => {
                        if (seenIds.has(item.id)) return false;
                        seenIds.add(item.id);
                        return true;
                    })
                    .sort((a, b) => b.date - a.date);

                if (combinedFeed.length > 0) {
                    itemsFound = combinedFeed.length;

                    // Pre-populate caches for instant loading
                    combinedFeed.forEach(item => {
                        if (item.source === 'inaturalist') {
                            galleryCache.set(`media-${item.id}`, item.media);
                            speciesCache.set(`species-${item.id}`, item.obs);
                        }
                    });

                    renderFeed(combinedFeed, false); // Append
                }

                // Always decrement the date for the next attempt
                lastLoadedDate.setDate(lastLoadedDate.getDate() - 1);
                daysTried++;

                // If we found items or reached the cap, we stop the loop
                if (itemsFound > 0) break;
                
                console.log(`No new items for ${lastLoadedDate.toDateString()}, trying previous day...`);
            }
        } catch (error) {
            console.warn("Infinite scroll error:", error);
        } finally {
            isLoadingMore = false;
        }
    }

    function setupLazyContent() {
        document.querySelectorAll('.checklist-card:not(.observed)').forEach(card => {
            card.classList.add('observed');
            lazyObserver.observe(card);
        });
    }

    async function fetchAndRenderSpecies(speciesEl, source) {
        if (!speciesEl || speciesEl.dataset.loaded) return;
        speciesEl.dataset.loaded = "true";

        try {
            let obs = [];
            let checklistComments = '';
            let effortInfo = null;
            const subId = speciesEl.dataset.id;
            const elementId = speciesEl.id;

            if (source === 'inaturalist') {
                obs = speciesCache.get(elementId) || [];
            } else {
                const details = await window.ebird.getChecklistDetails(subId);
                obs = details.obs || [];
                checklistComments = details.comments || '';
                effortInfo = details;
            }

            if (obs.length > 0 || checklistComments || effortInfo) {
                const renderSpeciesList = (items, showAll = false) => {
                    let html = '';
                    
                    // 0. Effort Info (eBird only)
                    if (effortInfo && effortInfo.protocolName) {
                        const dist = effortInfo.effortDistanceMiles || (effortInfo.effortDistanceKm ? (effortInfo.effortDistanceKm * 0.621371).toFixed(1) : null);
                        html += `
                            <div class="effort-summary">
                                ${effortInfo.numObservers > 1 ? `<span class="effort-pill">Observers: ${effortInfo.numObservers}</span>` : ''}
                                ${effortInfo.durationMin ? `<span class="effort-pill">Duration: ${effortInfo.durationMin} min</span>` : ''}
                                ${dist ? `<span class="effort-pill">Distance: ${dist} mi</span>` : ''}
                            </div>
                        `;
                    }

                    // 1. Checklist-level Comments
                    if (checklistComments) {
                        html += `
                            <div class="checklist-comments-box">
                                <p class="comment-text">"${checklistComments}"</p>
                            </div>
                        `;
                    }

                    const limit = showAll ? items.length : 5;
                    const itemsHtml = items.slice(0, limit).map(s => {
                        const hasSpeciesComments = s.comments && s.comments.trim().length > 0;
                        return `
                        <div class="species-item-wrapper">
                            <div class="species-item">
                                <div class="species-main-info">
                                    <span class="species-qty">${s.howMany || '1'}</span>
                                    <span class="species-name">${s.comName}</span>
                                </div>
                            </div>
                            ${hasSpeciesComments ? `
                                <div class="species-comment-box">
                                    <p>${s.comments}</p>
                                </div>
                            ` : ''}
                        </div>
                    `}).join('');

                    html += itemsHtml;

                    if (!showAll && items.length > 5) {
                        html += `<button class="show-all-btn" style="background: none; border: none; color: var(--primary); font-size: 0.85rem; font-weight: 600; cursor: pointer; padding: 0.5rem 0;">+ ${items.length - 5} more species (Show All)</button>`;
                    } else if (showAll && items.length > 5) {
                        html += `<button class="show-less-btn" style="background: none; border: none; color: var(--text-muted); font-size: 0.85rem; font-weight: 600; cursor: pointer; padding: 0.5rem 0;">Show Less</button>`;
                    }
                    return html;
                };

                speciesEl.innerHTML = renderSpeciesList(obs);
                
                // Interaction Logic (Show All/Less only)
                speciesEl.addEventListener('click', (e) => {
                    if (e.target.classList.contains('show-all-btn')) {
                        speciesEl.innerHTML = renderSpeciesList(obs, true);
                    } else if (e.target.classList.contains('show-less-btn')) {
                        speciesEl.innerHTML = renderSpeciesList(obs, false);
                    }
                });
            } else {
                speciesEl.innerHTML = '<p style="font-size: 0.8rem; color: #999;">No details available.</p>';
            }
        } catch (error) {
            console.error("Species/Comments fetch failed:", error);
            speciesEl.innerHTML = '<p style="font-size: 0.8rem; color: #16a34a;">No highlights found.</p>';
        }
    }

    async function fetchAndRenderMedia(mediaEl, source) {
        if (!mediaEl || mediaEl.dataset.loaded) return;
        mediaEl.dataset.loaded = "true";
        
        let uniqueAssets = [];
        const elementId = mediaEl.id;

        if (source === 'inaturalist') {
            uniqueAssets = galleryCache.get(elementId) || [];
        } else {
            const subIds = JSON.parse(mediaEl.getAttribute('data-subids') || "[]");
            const fetchPromises = subIds.map(async (id) => {
                const resp = await fetch(`https://search.macaulaylibrary.org/api/v1/search?subId=${id}&includeUnconfirmed=true`);
                if (resp.ok) {
                    const data = await resp.json();
                    return (data.results?.content || []);
                }
                return [];
            });

            const results = await Promise.all(fetchPromises);
            uniqueAssets = Array.from(new Map(results.flat().map(a => [a.catalogId, a])).values()).map(a => ({
                ...a,
                source: 'ebird'
            }));
        }

        if (uniqueAssets.length > 0) {
            galleryCache.set(elementId, uniqueAssets);
            const displayPhotos = uniqueAssets.slice(0, 4);
            
            const photoHtml = displayPhotos.map(photo => {
                let thumbUrl = '';
                if (source === 'inaturalist') {
                    thumbUrl = photo.url;
                } else {
                    const suffix = photo.mediaType === 'Audio' ? 'poster' : '1200';
                    thumbUrl = `https://cdn.download.ams.birds.cornell.edu/api/v1/asset/${photo.catalogId}/${suffix}`;
                }

                const creditText = source === 'inaturalist' 
                    ? `${photo.commonName} © ${photo.userDisplayName || 'Observer'}`
                    : `${photo.commonName} © ${photo.userDisplayName || 'Naturalist'}; Cornell Lab | Macaulay Library`;
                
                let badge = '';
                if (photo.mediaType === 'Video') badge = '<div class="media-badge video-badge">🎥 Video</div>';
                if (photo.mediaType === 'Audio') badge = '<div class="media-badge audio-badge">🔈 Audio</div>';

                return `
                    <div class="photo-wrapper">
                        ${badge}
                        <img src="${thumbUrl}" alt="${photo.commonName}" loading="lazy">
                        <div class="photo-credit">${creditText}</div>
                    </div>
                `;
            }).join('');

            mediaEl.innerHTML = `
                <div class="photo-grid ${uniqueAssets.length > 1 ? 'is-gallery' : ''} count-${displayPhotos.length}">
                    ${photoHtml}
                    ${uniqueAssets.length > 4 ? `<span class="photo-more">+${uniqueAssets.length - 4} others</span>` : ''}
                </div>
            `;
            mediaEl.style.display = 'block';
            mediaEl.style.margin = '1rem -1.5rem';
            mediaEl.closest('.checklist-card')?.classList.remove('no-media'); 
        } else {
            mediaEl.style.display = 'none';
        }
    }

    // Lightbox Functionality
    const lightbox = document.getElementById('lightbox-overlay');
    const lightboxContent = document.getElementById('lightbox-content');
    const lightboxClose = document.querySelector('.lightbox-close');
    const lightboxPrev = document.querySelector('.lightbox-prev');
    const lightboxNext = document.querySelector('.lightbox-next');

    function openLightbox(elementId) {
        const assets = galleryCache.get(elementId);
        if (!assets) return;

        // Hide navigation arrows if there's only one photo
        if (assets.length <= 1) {
            lightboxPrev.style.display = 'none';
            lightboxNext.style.display = 'none';
        } else {
            lightboxPrev.style.display = 'block';
            lightboxNext.style.display = 'block';
        }

        lightboxContent.innerHTML = assets.map(asset => {
            const isInat = asset.source === 'inaturalist';
            
            // Determine URLs
            let thumbUrl = '';
            let embedUrl = '';
            let sourceUrl = '';
            let sourceLabel = 'Macaulay Library';

            if (isInat) {
                thumbUrl = asset.url; // Already normalized to 'large' in api.js
                sourceUrl = `https://www.inaturalist.org/observations/${asset.catalogId}`;
                sourceLabel = 'iNaturalist';
                // iNat observations usually just display photos/audio directly, not needing a third-party embed usually
                // but if we support iNat audio, we use the raw asset.url
                embedUrl = asset.url;
            } else {
                const suffix = asset.mediaType === 'Audio' ? 'poster' : '1800';
                thumbUrl = `https://cdn.download.ams.birds.cornell.edu/api/v1/asset/${asset.catalogId}/${suffix}`;
                embedUrl = `https://www.macaulaylibrary.org/asset/${asset.catalogId}/embed`;
                sourceUrl = `https://macaulaylibrary.org/asset/${asset.catalogId}`;
                sourceLabel = 'Macaulay Library';
            }
            
            // Cleanup Label
            const typeLabel = asset.mediaType === 'Photo' ? '' : ` (${asset.mediaType})`;
            const credit = `${asset.commonName}${typeLabel} © ${asset.userDisplayName || 'Naturalist'}`;
            
            let mediaContent = '';
            if (asset.mediaType === 'Video' || (asset.mediaType === 'Audio' && !isInat)) {
                // Use official embed for eBird/Macaulay
                mediaContent = `
                    <div class="lightbox-embed-container">
                        <iframe data-src="${embedUrl}" class="lightbox-embed" frameborder="0" allowfullscreen allow="autoplay; encrypted-media"></iframe>
                    </div>`;
            } else if (asset.mediaType === 'Audio' && isInat) {
                // Use native audio player for iNaturalist sounds
                mediaContent = `<div class="lightbox-embed-container"><audio controls src="${asset.url}" style="width: 80%;"></audio></div>`;
            } else {
                mediaContent = `<img src="${thumbUrl}" alt="${asset.commonName}">`;
            }

            return `
                <div class="lightbox-photo-item">
                    ${mediaContent}
                    <div class="lightbox-caption">
                        <p>${credit}</p>
                        <p style="font-size: 0.75rem; margin-top: 5px;">
                            <a href="${sourceUrl}" target="_blank" style="color: var(--primary); text-decoration: none;">View on ${sourceLabel} ↗</a>
                        </p>
                    </div>
                </div>
            `;
        }).join('');

        // Smart Media Observer (Stops audio/video on navigate)
        const mediaObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const iframe = entry.target.querySelector('iframe');
                if (!iframe) return;

                if (entry.isIntersecting) {
                    // Start Playing
                    if (!iframe.src) iframe.src = iframe.getAttribute('data-src');
                } else {
                    // Stop Playing (Reset Src)
                    iframe.src = '';
                }
            });
        }, { threshold: 0.5 });

        lightboxContent.querySelectorAll('.lightbox-photo-item').forEach(item => mediaObserver.observe(item));

        lightbox.classList.add('active');
        document.body.style.overflow = 'hidden'; 
        lightboxContent.scrollLeft = 0; 
    }

    const closeLightbox = () => {
        lightbox.classList.remove('active');
        document.body.style.overflow = '';
        // Kill all media immediately
        lightboxContent.innerHTML = '';
    };

    lightboxClose.onclick = closeLightbox;

    lightboxPrev.onclick = (e) => {
        e.stopPropagation();
        lightboxContent.scrollBy({ left: -lightboxContent.clientWidth, behavior: 'smooth' });
    };

    lightboxNext.onclick = (e) => {
        e.stopPropagation();
        lightboxContent.scrollBy({ left: lightboxContent.clientWidth, behavior: 'smooth' });
    };

    // Global Key Events
    window.addEventListener('keydown', (e) => {
        if (!lightbox.classList.contains('active')) return;
        
        if (e.key === 'ArrowLeft') {
            lightboxContent.scrollBy({ left: -lightboxContent.clientWidth, behavior: 'smooth' });
        } else if (e.key === 'ArrowRight') {
            lightboxContent.scrollBy({ left: lightboxContent.clientWidth, behavior: 'smooth' });
        } else if (e.key === 'Escape') {
            closeLightbox();
        }
    });

    lightbox.onclick = (e) => {
        if (e.target === lightbox) closeLightbox();
    };
});
