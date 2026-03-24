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
        setupSidebar();
        
        // Initial load
        loadFeed();
    }

    function setupSidebar() {
        const sidebar = document.querySelector('.sidebar.left');
        const regionCard = document.createElement('div');
        regionCard.className = 'region-card';
        regionCard.innerHTML = `
            <h3>Region</h3>
            <select id="region-picker" style="width: 100%; padding: 0.5rem; border-radius: 8px; border: 1px solid #ddd;">
                <option value="US-NY-001" ${currentRegion === 'US-NY-001' ? 'selected' : ''}>Albany, NY</option>
                <option value="US-NY-061" ${currentRegion === 'US-NY-061' ? 'selected' : ''}>New York, NY</option>
                <option value="US-CA-075" ${currentRegion === 'US-CA-075' ? 'selected' : ''}>San Francisco, CA</option>
                <option value="US-MA-025" ${currentRegion === 'US-MA-025' ? 'selected' : ''}>Boston, MA</option>
            </select>
            <p style="font-size: 0.75rem; color: #999; margin-top: 0.5rem;">Enter a region code to change area.</p>
        `;
        sidebar.appendChild(regionCard);

        document.getElementById('region-picker').addEventListener('change', (e) => {
            currentRegion = e.target.value;
            localStorage.setItem('ebird_region', currentRegion);
            loadFeed();
        });
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
        
        try {
            // First time or when region changes, load the 'hot cache' of names
            await window.ebird.loadTaxonomy(currentRegion);
            
            const checklists = await window.ebird.getRecentChecklists(currentRegion);
            renderFeed(checklists);
            
            // Update stats
            document.getElementById('stat-checklists').innerText = checklists.length;
            document.getElementById('stat-hotspots').innerText = new Set(checklists.map(c => c.locId)).size;
        } catch (error) {
            feedItems.innerHTML = `<div class="error-state">Error loading feed: ${error.message}</div>`;
        }
    }

    async function renderFeed(checklists) {
        feedItems.innerHTML = '';
        
        if (checklists.length === 0) {
            feedItems.innerHTML = '<div class="empty-state">No recent checklists found in this region.</div>';
            return;
        }

        for (const list of checklists) {
            const card = document.createElement('div');
            card.className = 'checklist-card';
            
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
                    <div class="author-circle">${list.userDisplayName.charAt(0)}</div>
                    <div class="checklist-meta">
                        <h4>${list.userDisplayName}</h4>
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
            zoomControl: true,
            dragging: true,
            scrollWheelZoom: false // Keep feed scrolling smooth
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OSM'
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
