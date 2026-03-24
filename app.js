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
    let isLoadingMore = false;
    let lastLoadedDate = new Date();
    let scrollObserver = null;
    const galleryCache = new Map();

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
            console.log("Location detected:", latitude, longitude);

            try {
                // 1. Reverse geocode to get county name/state
                const geoResp = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`);
                const geoData = await geoResp.json();
                const county = geoData.address.county || geoData.address.city;
                const state = geoData.address.state;
                
                if (county && state) {
                    userRegionEl.innerText = `${county}, ${state}`;
                    
                    // 2. Map county/state to eBird region code
                    // We need the state code first (e.g. US-ME)
                    // Nominatim doesn't give us US-ME directly, so we'll look it up or fallback
                    // For now, let's assume US-[State] logic or fetch state list
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
            // Simplified: Fetch subregions for US-ME-type code
            // In a full app, we'd have a state-to-code map. 
            // For now, let's target Maine/NY/CA as primary regions
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
        feedItems.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Fetching the latest sightings...</p></div>';
        lastLoadedDate = new Date(); // Reset date on reload
        clearInfiniteScroll(); // Remove old observers

        try {
            await window.ebird.loadTaxonomy(currentRegion);
            const rawChecklists = await window.ebird.getRecentChecklists(currentRegion);
            const groupedChecklists = groupChecklists(rawChecklists);
            renderFeed(groupedChecklists, true); // True = overwrite

            // Set up start date for infinite scroll based on oldest item
            if (rawChecklists.length > 0) {
                const oldest = new Date(rawChecklists[rawChecklists.length - 1].obsDt);
                lastLoadedDate = new Date(oldest.setDate(oldest.getDate() - 1));
            }

            setupInfiniteScroll();
            
            // Fetch and update regional stats for today
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

            // Format date and time correctly
            // Some eBird responses have obsTime as a separate field or joined in isoObsDate
            let displayDate = list.obsDt;
            if (list.obsTime) {
                displayDate = `${list.obsDt} ${list.obsTime}`;
            }

            const dateObj = new Date(displayDate.replace(/-/g, "/")); // Better compat for parsing
            const dateStr = dateObj.toLocaleDateString([], {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });

            card.innerHTML = `
                <div class="card-header">
                    <div class="author-circle">${mainAuthor.charAt(0)}</div>
                    <div class="checklist-meta">
                        <h4>${authorText}</h4>
                        <p>${dateStr} • <a href="https://www.google.com/maps/search/?api=1&query=${list.loc.latitude},${list.loc.longitude}" target="_blank" class="location-link">${list.locName}</a></p>
                    </div>
                </div>
                <div class="card-summary">
                    <div class="obs-count">
                        <span>🐦</span> ${list.numSpecies} Species sighted
                    </div>
                </div>
                <!-- Media/Photo Container -->
                <div class="card-media" id="media-${list.subIds.join('_')}" data-subids='${JSON.stringify(list.subIds)}'>
                </div>
                
                <div class="species-list" id="species-${list.subId}">
                    <p style="font-size: 0.8rem; color: #999;">Loading highlights...</p>
                </div>
                <div class="card-footer">
                    <button class="action-btn kudos-btn" data-subid="${list.subId}"><span>❤️</span> <span class="label">Kudos</span></button>
                    <button class="action-btn comment-btn"><span>💬</span> Comment</button>
                </div>
            `;

            feedItems.appendChild(card);

            // Add interaction listeners
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
                const comment = prompt("Add a comment to this checklist:");
                if (comment) {
                    alert("Comment saved (locally)!");
                }
            });

            // Note: We no longer fetch details/media here. 
            // Instead, we let the setupLazyContent() observer trigger them as the user scrolls.
        }

        // Initialize Observer for Lazy Loading Content (Maps, Photos, Highlights)
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
            console.log(`Loading checklists for: ${lastLoadedDate.toDateString()}`);
            const rawChecklists = await window.ebird.getRecentChecklists(currentRegion, lastLoadedDate);

            if (rawChecklists.length > 0) {
                const grouped = groupChecklists(rawChecklists);
                renderFeed(grouped, false); // False = append
            }

            // Move to previous day
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
                    
                    // Trigger Species
                    const speciesEl = card.querySelector('[id^="species-"]');
                    if (speciesEl) {
                        const subId = speciesEl.id.replace('species-', '');
                        await fetchAndRenderSpecies(subId);
                    }

                    // Trigger Media (Silent Fetch)
                    const mediaEl = card.querySelector('[id^="media-"]');
                    if (mediaEl) {
                        await fetchAndRenderMedia(mediaEl.id);
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

    async function fetchAndRenderSpecies(subId) {
        const speciesEl = document.getElementById(`species-${subId}`);
        try {
            const details = await window.ebird.getChecklistDetails(subId);
            const obs = details.obs || [];

            if (obs.length > 0) {
                const renderSpecies = (items, showAll = false) => {
                    const limit = showAll ? items.length : 5;
                    let html = items.slice(0, limit).map(s => `
                        <div class="species-item">
                            <span class="species-name">${s.comName}</span>
                            <span class="species-qty">${s.howMany || '1'}</span>
                        </div>
                    `).join('');

                    if (!showAll && items.length > 5) {
                        html += `<button class="show-all-btn" style="background: none; border: none; color: var(--primary); font-size: 0.85rem; font-weight: 600; cursor: pointer; padding: 0.5rem 0;">+ ${items.length - 5} more species (Show All)</button>`;
                    } else if (showAll && items.length > 5) {
                        html += `<button class="show-less-btn" style="background: none; border: none; color: var(--text-muted); font-size: 0.85rem; font-weight: 600; cursor: pointer; padding: 0.5rem 0;">Show Less</button>`;
                    }
                    return html;
                };

                speciesEl.innerHTML = renderSpecies(obs);

                // Add event listeners for the new buttons
                speciesEl.addEventListener('click', (e) => {
                    if (e.target.classList.contains('show-all-btn')) {
                        speciesEl.innerHTML = renderSpecies(obs, true);
                    } else if (e.target.classList.contains('show-less-btn')) {
                        speciesEl.innerHTML = renderSpecies(obs, false);
                    }
                });
            } else {
                speciesEl.innerHTML = '<p style="font-size: 0.8rem; color: #999;">No species details available.</p>';
            }
        } catch (error) {
            console.error("Species fetch failed:", error);
            speciesEl.innerHTML = '<p style="font-size: 0.8rem; color: red;">Failed to load details.</p>';
        }
    }

    async function fetchAndRenderMedia(elementId) {
        const mediaEl = document.getElementById(elementId);
        if (!mediaEl) return;
        
        const subIds = JSON.parse(mediaEl.getAttribute('data-subids') || "[]");
        let allAssets = [];

        try {
            // Fetch media for every subId in the group (Multi-subId Handshake)
            const fetchPromises = subIds.map(async (id) => {
                // includeUnconfirmed API v1 expects includeUnconfirmed=true
                const resp = await fetch(`https://search.macaulaylibrary.org/api/v1/search?subId=${id}&includeUnconfirmed=true`);
                if (resp.ok) {
                    const data = await resp.json();
                    // Include all media types (Photo, Video, Audio)
                    return (data.results?.content || []);
                }
                return [];
            });

            const results = await Promise.all(fetchPromises);
            const uniqueAssets = Array.from(new Map(results.flat().map(a => [a.catalogId, a])).values());
            
            if (uniqueAssets.length > 0) {
                galleryCache.set(elementId, uniqueAssets);
                
                const displayPhotos = uniqueAssets.slice(0, 4);
                
                const photoHtml = displayPhotos.map(photo => {
                    const suffix = photo.mediaType === 'Audio' ? 'poster' : '1200';
                    const thumbUrl = `https://cdn.download.ams.birds.cornell.edu/api/v1/asset/${photo.catalogId}/${suffix}`;
                    const creditText = `${photo.commonName} © ${photo.userDisplayName || 'Birder'}; Cornell Lab | Macaulay Library`;
                    
                    // Determine Badge
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
        } catch (error) {
            console.warn("Media fetch failed for group:", subIds, error.message);
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
            const suffix = asset.mediaType === 'Audio' ? 'poster' : '1800';
            const thumbUrl = `https://cdn.download.ams.birds.cornell.edu/api/v1/asset/${asset.catalogId}/${suffix}`;
            const embedUrl = `https://www.macaulaylibrary.org/asset/${asset.catalogId}/embed`;
            
            // Cleanup Label
            const typeLabel = asset.mediaType === 'Photo' ? '' : ` (${asset.mediaType})`;
            const credit = `${asset.commonName}${typeLabel} © ${asset.userDisplayName || 'Birder'}`;
            const mlUrl = `https://macaulaylibrary.org/asset/${asset.catalogId}`;
            
            let mediaContent = '';
            if (asset.mediaType === 'Video' || asset.mediaType === 'Audio') {
                // Use data-src for Lazy Loading/Stopping
                mediaContent = `
                    <div class="lightbox-embed-container">
                        <iframe data-src="${embedUrl}" class="lightbox-embed" frameborder="0" allowfullscreen allow="autoplay; encrypted-media"></iframe>
                    </div>`;
            } else {
                mediaContent = `<img src="${thumbUrl}" alt="${asset.commonName}">`;
            }

            return `
                <div class="lightbox-photo-item">
                    ${mediaContent}
                    <div class="lightbox-caption">
                        <p>${credit}</p>
                        <p style="font-size: 0.75rem; margin-top: 5px;">
                            <a href="${mlUrl}" target="_blank" style="color: var(--primary); text-decoration: none;">Explore on Macaulay Library ↗</a>
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
