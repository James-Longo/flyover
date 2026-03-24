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

    let currentRegion = localStorage.getItem('ebird_region') || "US-ME-009";
    let lastLoadedDate = new Date();
    let isLoadingMore = false;
    let scrollObserver = null;

    // Initialize state
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
            // Group by location and exact time (heuristic for shared checklists)
            const key = `${list.locId}_${list.isoObsDate}_${list.numSpecies}`;
            if (!groups.has(key)) {
                groups.set(key, { ...list, contributors: [list.userDisplayName] });
            } else {
                const group = groups.get(key);
                if (!group.contributors.includes(list.userDisplayName)) {
                    group.contributors.push(list.userDisplayName);
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
                        <p>${dateStr} • ${list.locName}</p>
                    </div>
                </div>
                <div class="card-summary">
                    <div class="obs-count">
                        <span>🐦</span> ${list.numSpecies} Species sighted
                    </div>
                </div>
                <!-- Media/Photo Container -->
                <div class="card-media" id="media-${list.subId}">
                    <div class="photo-placeholder">Checking for birding photos...</div>
                </div>
                
                <!-- Map Container (Lazy loaded) -->
                <div class="map-container lazy-map" id="map-${list.subId}" 
                     data-lat="${list.loc.latitude}" 
                     data-lng="${list.loc.longitude}">
                    <p style="text-align: center; padding: 100px; color: #999;">Loading Map...</p>
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
                    const el = entry.target;
                    const subId = el.id.split('-').slice(1).join('-'); // Handle media-S123 etc.
                    
                    if (el.classList.contains('lazy-map')) {
                        const lat = parseFloat(el.getAttribute('data-lat'));
                        const lng = parseFloat(el.getAttribute('data-lng'));
                        renderMap(subId, lat, lng);
                    } else if (el.id.startsWith('species-')) {
                        await fetchAndRenderSpecies(subId);
                    } else if (el.id.startsWith('media-')) {
                        await fetchAndRenderMedia(subId);
                    }

                    contentObserver.unobserve(el);
                }
            });
        }, { rootMargin: '200px' });

        // Observe all lazy elements
        document.querySelectorAll('.lazy-map, [id^="species-"], [id^="media-"]').forEach(el => {
            contentObserver.observe(el);
        });
    }
function renderMap(subId, lat, lng) {
        // Leaflet expects the ID without the #
        const map = L.map(`map-${subId}`, {
            center: [lat, lng],
            zoom: 13,
            zoomControl: false, // Cleaner Strava-like look
            dragging: false,    // No more scroll interference
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
            keyboard: false,
            touchZoom: false
        });

        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri'
        }).addTo(map);

        // Add a marker for the birding hotspot/location
        L.marker([lat, lng]).addTo(map);

        // Ensure map renders properly in case container size changed
        setTimeout(() => map.invalidateSize(), 100);
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

    async function fetchAndRenderMedia(subId) {
        const mediaEl = document.getElementById(`media-${subId}`);
        try {
            // Macaulay Library API for checklist media
            const resp = await fetch(`https://search.macaulaylibrary.org/api/v1/search?subId=${subId}`);
            if (!resp.ok) throw new Error("API Limit or Network Error");
            
            const data = await resp.json();
            const assets = (data.results?.content || []).filter(a => a.mediaType === 'Photo');
            
            if (assets.length > 0) {
                // Show up to 4 photos in a grid layout
                const displayPhotos = assets.slice(0, 4);
                
                const photoHtml = displayPhotos.map(photo => {
                    const thumbUrl = `https://cdn.download.ams.birds.cornell.edu/api/v1/asset/${photo.catalogId}/1200`;
                    const creditText = `${photo.commonName} © ${photo.userDisplayName || 'Birder'}; Cornell Lab | Macaulay Library`;
                    return `
                        <div class="photo-wrapper">
                            <img src="${thumbUrl}" alt="${photo.commonName}" loading="lazy">
                            <div class="photo-credit">${creditText}</div>
                        </div>
                    `;
                }).join('');

                mediaEl.innerHTML = `
                    <div class="photo-grid ${assets.length > 1 ? 'is-gallery' : ''} count-${displayPhotos.length}">
                        ${photoHtml}
                        ${assets.length > 4 ? `<span class="photo-more">+${assets.length - 4} others</span>` : ''}
                    </div>
                `;
                mediaEl.style.display = 'block';
            } else {
                mediaEl.style.display = 'none'; // Hide if no photos exist
            }
        } catch (error) {
            console.warn("Media fetch failed for subId:", subId, error.message);
            mediaEl.style.display = 'none';
        }
    }
});
