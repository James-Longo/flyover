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
    const userRegionEl = document.getElementById('user-region');
    const regionSelect = document.createElement('div'); // Will inject into sidebar

    // Initialize state
    let currentRegion = localStorage.getItem('ebird_region') || 'US-ME-009'; // Default to Penobscot, ME
    let currentCoords = { lat: 44.8016, lng: -68.7712 }; // Default to Bangor, ME
    let isLoadingMore = false;
    let lastLoadedDate = new Date();
    let scrollObserver = null;
    const galleryCache = new Map();
    const speciesCache = new Map();

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
                    userRegionEl.innerText = `${county}, ${state}`;
                    
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
                window.inat.fetchObservations(currentCoords.lat, currentCoords.lng)
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
            const groupedInat = groupInatObservations(inatData);
            const combinedFeed = [...normalizedEbird, ...groupedInat].sort((a, b) => b.date - a.date);
            
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
            const stats = await window.ebird.getRegionalStats(currentRegion);
            
            document.getElementById('stat-checklists').innerText = stats.numChecklists || 0;
            document.getElementById('stat-species').innerText = stats.numSpecies || 0;
            document.getElementById('stat-contributors').innerText = stats.numContributors || 0;
        } catch (e) {
            console.warn("Could not update local stats:", e);
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
            const sourceClass = isInat ? 'source-badge-inat' : 'source-badge-ebird';
            const sourceLabel = isInat ? 'iNaturalist' : 'eBird';

            card.innerHTML = `
                <div class="card-header">
                    <div class="author-circle">${mainAuthor.charAt(0)}</div>
                    <div class="checklist-meta">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <h4>${authorText}</h4>
                            <span class="source-badge ${sourceClass}">${sourceLabel}</span>
                        </div>
                        <p>${dateStr} • <a href="https://www.google.com/maps/search/?api=1&query=${list.loc.latitude},${list.loc.longitude}" target="_blank" class="location-link">${list.locName}</a></p>
                    </div>
                </div>
                <div class="card-summary">
                    <div class="obs-count">
                        <span>${isInat ? '🌿' : '🐦'}</span> ${list.numSpecies} ${isInat ? 'Observation' : 'Species sighted'}
                    </div>
                </div>
                <!-- Media/Photo Container -->
                <div class="card-media" id="media-${list.id}" data-id="${list.id}" data-source="${list.source}" data-subids='${JSON.stringify(list.subIds || [list.id])}'>
                </div>
                
                <div class="species-list" id="species-${list.id}" data-id="${list.id}" data-source="${list.source}">
                    <p style="font-size: 0.8rem; color: #999;">Loading highlights...</p>
                </div>
                <div class="card-footer">
                    <button class="action-btn kudos-btn" data-id="${list.id}"><span>❤️</span> <span class="label">Kudos</span></button>
                    <button class="action-btn comment-btn"><span>💬</span> Comment</button>
                </div>
            `;

            feedItems.appendChild(card);

            // Interaction Listeners
            const kudosBtn = card.querySelector('.kudos-btn');
            kudosBtn.addEventListener('click', () => {
                kudosBtn.classList.toggle('active');
                const label = kudosBtn.querySelector('.label');
                if (kudosBtn.classList.contains('active')) {
                    kudosBtn.style.color = 'var(--primary)';
                    label.innerText = 'Kicked it!';
                } else {
                    kudosBtn.style.color = '';
                    label.innerText = 'Kudos';
                }
            });

            const commentBtn = card.querySelector('.comment-btn');
            commentBtn.addEventListener('click', () => {
                const comment = prompt("Add a comment to this sighting:");
                if (comment) alert("Comment saved (locally)!");
            });
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

        try {
            console.log(`Loading sightings for: ${lastLoadedDate.toDateString()}`);
            const rawChecklists = await window.ebird.getRecentChecklists(currentRegion, lastLoadedDate);
            const normalizedEbird = groupChecklists(rawChecklists).map(list => {
                const dateStr = list.obsTime ? `${list.obsDt} ${list.obsTime}` : list.obsDt;
                return {
                    source: 'ebird',
                    id: list.subId,
                    date: new Date(dateStr.replace(/-/g, "/")),
                    ...list
                };
            });

            // Note: Parallel fetch for loadMore too
            const inatData = await window.inat.fetchObservations(currentCoords.lat, currentCoords.lng);
            const groupedInat = groupInatObservations(inatData);
            
            groupedInat.forEach(item => {
                galleryCache.set(`media-${item.id}`, item.media);
                speciesCache.set(`species-${item.id}`, item.obs);
            });

            const combinedFeed = [...normalizedEbird, ...groupedInat].sort((a, b) => b.date - a.date);
            renderFeed(combinedFeed, false); // False = append

            lastLoadedDate.setDate(lastLoadedDate.getDate() - 1);
        } catch (error) {
            console.warn("Infinite scroll error:", error);
        } finally {
            isLoadingMore = false;
        }
    }

    function setupLazyContent() {
        const contentObserver = new IntersectionObserver((entries) => {
            entries.forEach(async entry => {
                if (entry.isIntersecting) {
                    const card = entry.target;
                    
                    const speciesEl = card.querySelector('.species-list');
                    if (speciesEl) {
                        await fetchAndRenderSpecies(speciesEl.id, speciesEl.dataset.source);
                    }

                    const mediaEl = card.querySelector('.card-media');
                    if (mediaEl) {
                        await fetchAndRenderMedia(mediaEl.id, mediaEl.dataset.source);
                    }

                    contentObserver.unobserve(card);
                }
            });
        }, { rootMargin: '200px' });

        document.querySelectorAll('.checklist-card:not(.observed)').forEach(card => {
            card.classList.add('observed');
            contentObserver.observe(card);
        });
    }

    async function fetchAndRenderSpecies(elementId, source) {
        const speciesEl = document.getElementById(elementId);
        if (!speciesEl) return;

        try {
            let obs = [];
            let checklistComments = '';
            const subId = elementId.replace('species-', '');

            if (source === 'inaturalist') {
                obs = speciesCache.get(elementId) || [];
            } else {
                const details = await window.ebird.getChecklistDetails(subId);
                obs = details.obs || [];
                checklistComments = details.comments || '';
            }

            if (obs.length > 0 || checklistComments) {
                const renderSpeciesList = (items, showAll = false) => {
                    let html = '';
                    
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
                        const uniqueCommentId = `comment-${subId}-${s.speciesCode}`;
                        return `
                        <div class="species-item-wrapper">
                            <div class="species-item" ${hasSpeciesComments ? `data-toggle="${uniqueCommentId}" style="cursor: pointer;"` : ''}>
                                <div class="species-main-info">
                                    <span class="species-qty">${s.howMany || '1'}</span>
                                    <span class="species-name">${s.comName} ${s.scientificName ? `<em style="font-size: 0.75rem; color: #999; margin-left: 5px;">(${s.scientificName})</em>` : ''}</span>
                                </div>
                                ${hasSpeciesComments ? '<span class="note-indicator">View Notes ▾</span>' : ''}
                            </div>
                            ${hasSpeciesComments ? `
                                <div class="species-comment-dropdown" id="${uniqueCommentId}" style="display: none;">
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
                
                // Interaction Logic
                speciesEl.addEventListener('click', (e) => {
                    if (e.target.classList.contains('show-all-btn')) {
                        speciesEl.innerHTML = renderSpeciesList(obs, true);
                    } else if (e.target.classList.contains('show-less-btn')) {
                        speciesEl.innerHTML = renderSpeciesList(obs, false);
                    } else {
                        const speciesItem = e.target.closest('.species-item');
                        if (speciesItem && speciesItem.dataset.toggle) {
                            const commentId = speciesItem.dataset.toggle;
                            const commentBox = speciesEl.querySelector(`#${commentId}`);
                            const indicator = speciesItem.querySelector('.note-indicator');
                            if (commentBox) {
                                const isHidden = commentBox.style.display === 'none';
                                commentBox.style.display = isHidden ? 'block' : 'none';
                                speciesItem.classList.toggle('is-expanded', isHidden);
                                if (indicator) indicator.innerText = isHidden ? 'Hide Notes ▴' : 'View Notes ▾';
                            }
                        }
                    }
                });
            } else {
                speciesEl.innerHTML = '<p style="font-size: 0.8rem; color: #999;">No details available.</p>';
            }
        } catch (error) {
            console.error("Species/Comments fetch failed:", error);
            speciesEl.innerHTML = '<p style="font-size: 0.8rem; color: red;">Failed to load details.</p>';
        }
    }

    async function fetchAndRenderMedia(elementId, source) {
        const mediaEl = document.getElementById(elementId);
        if (!mediaEl) return;
        
        let uniqueAssets = [];

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
                    ? `${photo.commonName} © ${photo.userDisplayName || 'iNaturalist Observer'}`
                    : `${photo.commonName} © ${photo.userDisplayName || 'Birder'}; Cornell Lab | Macaulay Library`;
                
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
            const credit = `${asset.commonName}${typeLabel} © ${asset.userDisplayName || 'Birder'}`;
            
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
