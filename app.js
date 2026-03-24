/**
 * BirdFeed Application Logic
 */

document.addEventListener('DOMContentLoaded', () => {
    const apiInput = document.getElementById('api-key-input');
    const loginBtn = document.getElementById('login-btn');
    const demoBtn = document.getElementById('demo-btn');
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

    demoBtn.addEventListener('click', () => {
        login(null); // Demo mode
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


    function detectLocation() {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                async (position) => {
                    const { latitude, longitude } = position.coords;
                    // For a real app, we'd use reverse geocoding to get a county/region code.
                    // For the prototype, we'll inform the user and keep the default or try to find a nearby hotspot's region.
                    userRegionEl.innerText = `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`;
                    console.log("Location detected:", latitude, longitude);
                },
                (error) => {
                    console.warn("Geolocation failed:", error);
                    userRegionEl.innerText = "Albany, NY (Default)";
                }
            );
        } else {
            userRegionEl.innerText = "Albany, NY (Default)";
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

            // Update stats
            const checklistsCount = document.querySelectorAll('.checklist-card').length;
            document.getElementById('stat-checklists').innerText = checklistsCount;
            document.getElementById('stat-hotspots').innerText = new Set(groupedChecklists.map(c => c.locId)).size;
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
                authorText = `${mainAuthor} birded with ${authors[1]}`;
            } else if (authors.length > 2) {
                authorText = `${mainAuthor} birded with ${authors[1]} and ${authors.length - 2} others`;
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
                        <span>🦅</span> ${list.numSpecies} Species sighted
                    </div>
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
            
            // Fetch checklist details for species highlights
            fetchAndRenderSpecies(list.subId);
        }

        // Initialize Observer for Lazy Loading Maps
        setupLazyMaps();
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

    function setupLazyMaps() {
        const mapObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const el = entry.target;
                    const subId = el.id.replace('map-', '');
                    const lat = parseFloat(el.getAttribute('data-lat'));
                    const lng = parseFloat(el.getAttribute('data-lng'));
                    
                    renderMap(subId, lat, lng);
                    mapObserver.unobserve(el); // Stop observing once rendered
                }
            });
        }, { rootMargin: '200px' });

        document.querySelectorAll('.lazy-map').forEach(el => mapObserver.observe(el));
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
});
