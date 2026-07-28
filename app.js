/**
 * BirdFeed Application Logic
 */

document.addEventListener('DOMContentLoaded', () => {
    const apiInput = document.getElementById('api-key-input');
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const feedScreen = document.getElementById('feed-screen');
    const ebirdConnectCard = document.getElementById('ebird-connect-card');
    const feedItems = document.getElementById('feed-items');
    const locationSearch = document.getElementById('location-search');
    const searchBtn = document.getElementById('search-btn');
    const gpsBtn = document.getElementById('gps-btn');
    const searchResults = document.getElementById('search-results');
    const fabLocation = document.getElementById('fab-location');
    const locationModal = document.getElementById('location-modal');
    const closeModal = document.querySelector('.close-modal');
    const regionSelect = document.createElement('div'); // Will inject into sidebar

    // Initialize state
    let currentCoords = localStorage.getItem('last_lat') ? {
        lat: parseFloat(localStorage.getItem('last_lat')),
        lng: parseFloat(localStorage.getItem('last_lng'))
    } : null;
    let currentRegion = localStorage.getItem('ebird_region') || null; 
    let currentRegionName = localStorage.getItem('ebird_region_name') || null;
    let isLoadingMore = false;
    let lastLoadedDate = new Date();
    let scrollObserver = null;
    let searchDebounce = null;
    const galleryCache = new Map();
    const speciesCache = new Map();
    const seenIds = new Set(); // Track unique sightings to avoid UI ghosts
    let allFeedItems = []; // Everything loaded so far, for the map view

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
        window.ebird.setApiKey(savedKey);
        if (logoutBtn) logoutBtn.style.display = 'block';
        if (ebirdConnectCard) ebirdConnectCard.style.display = 'none';
    } else {
        // Mobile hides the sidebar; this class lets the connect card
        // punch through so phones aren't stuck iNat-only with no way in
        document.body.classList.add('no-ebird-key');
    }

    // Auto-start detection
    detectLocation();

    // Event Listeners
    loginBtn.addEventListener('click', () => {
        const key = apiInput.value.trim();
        if (key) {
            connectEbird(key);
        } else {
            alert("Please enter a valid API key.");
        }
    });

    logoutBtn.addEventListener('click', () => {
        localStorage.removeItem('ebird_api_key');
        localStorage.removeItem('ebird_region');
        localStorage.removeItem('ebird_region_name');
        window.location.reload();
    });

    searchBtn.addEventListener('click', () => handleSearch());
    locationSearch.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleSearch();
    });

    gpsBtn.addEventListener('click', () => detectLocation(true));

    // Modal Logic
    fabLocation.addEventListener('click', () => {
        locationModal.classList.add('active');
        locationSearch.focus();
    });

    closeModal.addEventListener('click', () => {
        locationModal.classList.remove('active');
    });

    window.addEventListener('click', (e) => {
        if (e.target === locationModal) {
            locationModal.classList.remove('active');
        }
    });

    locationSearch.addEventListener('input', () => {
        clearTimeout(searchDebounce);
        const query = locationSearch.value.trim();
        if (query.length < 3) {
            searchResults.style.display = 'none';
            return;
        }
        searchDebounce = setTimeout(() => fetchSuggestions(query), 300);
    });

    // Close results when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container')) {
            searchResults.style.display = 'none';
        }
    });

    // Global Media Click Handler (Event Delegation for instant response)
    feedItems.addEventListener('click', (e) => {
        const mediaCard = e.target.closest('.card-media');
        if (mediaCard) {
            openLightbox(mediaCard.id);
        }
    });

    async function connectEbird(key) {
        if (key) {
            localStorage.setItem('ebird_api_key', key);
            window.ebird.setApiKey(key);
        }
        
        if (ebirdConnectCard) ebirdConnectCard.style.display = 'none';
        if (logoutBtn) logoutBtn.style.display = 'block';

        // Refresh to initialize everything with the new key
        location.reload();
    }


    async function fetchSuggestions(query) {
        try {
            const resp = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=5`);
            const results = await resp.json();
            showSuggestions(results);
        } catch (e) {
            console.warn("Autofill failed:", e);
        }
    }

    function showSuggestions(results) {
        if (!results || results.length === 0) {
            searchResults.style.display = 'none';
            return;
        }

        searchResults.innerHTML = '';
        results.forEach(res => {
            const div = document.createElement('div');
            div.className = 'result-item';
            div.innerText = res.display_name;
            div.onclick = () => selectResult(res);
            searchResults.appendChild(div);
        });
        searchResults.style.display = 'block';
    }

    async function selectResult(loc) {
        searchResults.style.display = 'none';
        locationModal.classList.remove('active');
        locationSearch.value = loc.display_name;
        
        currentCoords = { lat: parseFloat(loc.lat), lng: parseFloat(loc.lon) };
        
        const county = loc.address.county || loc.address.city || loc.address.town || loc.address.suburb || "Local Area";
        const state = loc.address.state || loc.address.country;
        currentRegionName = `${county}, ${state}`;
        
        // Cache it
        localStorage.setItem('last_lat', currentCoords.lat);
        localStorage.setItem('last_lng', currentCoords.lng);
        localStorage.setItem('ebird_region_name', currentRegionName);

        // Update eBird region using hotspots
        currentRegion = await window.ebird.getRegionFromCoords(currentCoords.lat, currentCoords.lng);
        if (currentRegion) localStorage.setItem('ebird_region', currentRegion);

        // Refresh feed
        loadFeed();
    }

    async function handleSearch() {
        const query = locationSearch.value.trim();
        if (!query) return;

        searchBtn.innerText = '⏳';
        try {
            const resp = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=1`);
            const results = await resp.json();

            if (results && results.length > 0) {
                const loc = results[0];
                currentCoords = { lat: parseFloat(loc.lat), lng: parseFloat(loc.lon) };
                
                const county = loc.address.county || loc.address.city || loc.address.town || loc.address.suburb || "Local Area";
                const state = loc.address.state || loc.address.country;
                currentRegionName = `${county}, ${state}`;
                
                // Cache it
                localStorage.setItem('last_lat', currentCoords.lat);
                localStorage.setItem('last_lng', currentCoords.lng);
                localStorage.setItem('ebird_region_name', currentRegionName);

                // Update eBird region using hotspots (most reliable)
                currentRegion = await window.ebird.getRegionFromCoords(currentCoords.lat, currentCoords.lng);
                if (currentRegion) localStorage.setItem('ebird_region', currentRegion);

                // Refresh feed
                loadFeed();
            } else {
                alert("Location not found. Try a city or county name.");
            }
        } catch (error) {
            console.error("Search failed:", error);
            alert("Search failed. Please try again.");
        } finally {
            searchBtn.innerText = 'Search';
        }
    }

    async function detectLocation(force = false) {
        // If we already have coords from search or cache, just load (unless forced)
        if (currentCoords && !force) {
            loadFeed();
            return;
        }

        if (force) {
            gpsBtn.innerText = 'Locating...';
            locationSearch.value = ''; // Clear search on GPS force
        }

        if (!navigator.geolocation) {
            console.log("Geolocation not supported.");
            feedItems.innerHTML = '<div class="error-state">Geolocation is not supported by your browser.</div>';
            return;
        }

        navigator.geolocation.getCurrentPosition(async (position) => {
            const { latitude, longitude } = position.coords;
            currentCoords = { lat: latitude, lng: longitude };
            localStorage.setItem('last_lat', latitude);
            localStorage.setItem('last_lng', longitude);
            console.log("Location detected:", latitude, longitude);

            try {
                const geoResp = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`);
                const geoData = await geoResp.json();
                const county = geoData.address.county || geoData.address.city || geoData.address.town;
                const state = geoData.address.state;
                
                if (county && state) {
                    currentRegionName = `${county}, ${state}`;
                    localStorage.setItem('ebird_region_name', currentRegionName);
                }

                const foundRegion = await window.ebird.getRegionFromCoords(latitude, longitude);
                if (foundRegion) {
                    currentRegion = foundRegion;
                    localStorage.setItem('ebird_region', currentRegion);
                }
                loadFeed();
            } catch (error) {
                console.warn("Reverse geocode failed:", error);
                loadFeed();
            } finally {
                if (force) {
                    gpsBtn.innerText = 'Use My Current Location';
                    locationModal.classList.remove('active');
                }
            }
        }, (error) => {
            console.warn("Geolocation error:", error);
            feedItems.innerHTML = `<div class="error-state">Please enable location access or search manually. (${error.message})</div>`;
            if (force) gpsBtn.innerText = 'Use My Current Location';
            // Don't dead-end: give the user the search modal so they can recover.
            locationModal.classList.add('active');
            locationSearch.focus();
        }, { timeout: 10000 });
    }

    async function findEbirdRegion(countyName, stateName, address) {
        try {
            if (!address) return null;
            // 1. Try to get state code from Nominatim ISO field (e.g., "US-ME")
            let stateCode = address['ISO3166-2-lvl4'];
            
            // 2. Fallback: Lookup state code from eBird for this country
            let states = [];
            if (!stateCode && address.country_code) {
                const countryCode = address.country_code.toUpperCase();
                states = await window.ebird.fetchJson(`/ref/region/list/subnational1/${countryCode}`);
                const stateMatch = states.find(s => s.name.toLowerCase() === stateName.toLowerCase());
                if (stateMatch) stateCode = stateMatch.code;
            }

            if (!stateCode) {
                // Try matching stateName against subnational1
                const stateMatch = states.find(s => s.name.toLowerCase() === stateName.toLowerCase());
                if (stateMatch) {
                    // We found the region directly at subnational1 (e.g. London might be here in some systems)
                    // Or this is the parent region we need to search within
                    stateCode = stateMatch.code;
                }
            }

            if (!stateCode) return null;

            // 3. Get county list for this state and match
            const regions = await window.ebird.fetchJson(`/ref/region/list/subnational2/${stateCode}`);
            const cleanCounty = countyName.replace(/ (County|Parish|Borough|City|Province|Region)/, '');
            const match = regions.find(r => r.name.toLowerCase().includes(cleanCounty.toLowerCase()));
            
            if (match) return match.code;
            
            // If no county match, maybe the stateCode itself is the target (common internationally)
            return stateCode;
        } catch (e) {
            console.warn("Region lookup failed:", e);
            return null;
        }
    }

    async function loadFeed() {
        if (!currentCoords) {
            feedItems.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Detecting your location...</p></div>';
            return;
        }
        feedItems.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Fetching from eBird & iNaturalist...</p></div>';
        lastLoadedDate = new Date(); // Reset date on reload
        clearInfiniteScroll(); // Remove old observers
        seenIds.clear(); // Clear deduplication set for fresh load

        try {
            // The cached region can go stale or belong to a previous location,
            // which would silently fill the feed with checklists from the wrong
            // part of the world. Always re-derive it from the current coords.
            if (localStorage.getItem('ebird_api_key')) {
                const freshRegion = await window.ebird.getRegionFromCoords(currentCoords.lat, currentCoords.lng);
                if (freshRegion && freshRegion !== currentRegion) {
                    currentRegion = freshRegion;
                    localStorage.setItem('ebird_region', currentRegion);
                }
            }

            if (currentRegion) await window.ebird.loadTaxonomy(currentRegion);
            
            // Parallel Fetch
            let ebirdPromise;
            const hasEbirdKey = !!localStorage.getItem('ebird_api_key');
            
            if (hasEbirdKey) {
                if (currentRegion) {
                    // Preferred: Region-based checklists (has usernames)
                    ebirdPromise = window.ebird.getRecentChecklists(currentRegion)
                        .then(data => groupChecklists(data).map(list => {
                            const dateStr = list.obsTime ? `${list.obsDt} ${list.obsTime}` : list.obsDt;
                            return {
                                source: 'ebird',
                                id: list.subId,
                                date: new Date(dateStr.replace(/-/g, "/")),
                                ...list
                            };
                        }));
                } else {
                    // Fallback: Coordinate-based observations (no usernames)
                    ebirdPromise = window.ebird.getNearbyObservations(currentCoords.lat, currentCoords.lng, 20, 7)
                        .then(data => groupEbirdObservations(data));
                }
            } else {
                ebirdPromise = Promise.resolve([]);
            }

            // One source failing shouldn't blank the whole feed
            ebirdPromise = ebirdPromise.catch(err => {
                console.warn("eBird feed unavailable, showing iNaturalist only:", err);
                return [];
            });

            const [normalizedEbird, inatData] = await Promise.all([
                ebirdPromise,
                window.inat.fetchObservations(currentCoords.lat, currentCoords.lng, 20, null)
            ]);

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

            allFeedItems = [...combinedFeed];
            refreshMap(true);

            renderFeed(combinedFeed, true); // True = overwrite

            // Dynamically set lastLoadedDate to the day BEFORE the oldest item found
            if (combinedFeed.length > 0) {
                lastLoadedDate = new Date(combinedFeed[combinedFeed.length - 1].date);
                lastLoadedDate.setDate(lastLoadedDate.getDate() - 1);
            } else {
                lastLoadedDate.setDate(lastLoadedDate.getDate() - 1);
            }

            setupInfiniteScroll();
            updateRegionalStats();
        } catch (error) {
            console.error("Feed load failed:", error);
            feedItems.innerHTML = `<div class="error-state">Error loading feed: ${error.message}</div>`;
        }
    }

    function groupEbirdObservations(obs) {
        const groups = new Map();
        obs.forEach(o => {
            if (!groups.has(o.subId)) {
                groups.set(o.subId, {
                    source: 'ebird',
                    id: o.subId,
                    date: new Date(o.obsDt.replace(/-/g, "/")),
                    obsDt: o.obsDt,
                    locName: o.locName,
                    userDisplayName: o.userDisplayName || "Observer",
                    loc: { latitude: o.lat, longitude: o.lng },
                    numSpecies: 1,
                    speciesCodes: [o.speciesCode]
                });
            } else {
                const group = groups.get(o.subId);
                if (!group.speciesCodes.includes(o.speciesCode)) {
                    group.speciesCodes.push(o.speciesCode);
                    group.numSpecies++;
                }
            }
        });
        return Array.from(groups.values());
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
        if (!currentCoords) return;
        try {
            // Stats should follow the currently detected county/region code
            const ebirdStatsPromise = currentRegion 
                ? window.ebird.getRegionalStats(currentRegion) 
                : Promise.resolve({ numChecklists: 0, numSpecies: 0 });
            const [ebirdStats, inatStats] = await Promise.all([
                ebirdStatsPromise,
                window.inat.getDailyStats(currentCoords.lat, currentCoords.lng)
            ]);
            
            document.getElementById('stats-ebird-lists').innerText = ebirdStats.numChecklists || 0;
            document.getElementById('stats-ebird-species').innerText = ebirdStats.numSpecies || 0;
            document.getElementById('stats-inat-obs').innerText = inatStats.numObservations || 0;
            document.getElementById('stats-inat-species').innerText = inatStats.numSpecies || 0;

            const scopeText = document.getElementById('stats-scope-text');
            const ebirdListsItem = document.getElementById('ebird-stats-lists');
            const ebirdSppItem = document.getElementById('ebird-stats-spp');
            const hasEbird = !!localStorage.getItem('ebird_api_key');

            if (scopeText) {
                const coordsText = `${currentCoords.lat.toFixed(2)}, ${currentCoords.lng.toFixed(2)}`;
                if (hasEbird) {
                    scopeText.innerText = `eBird: ${currentRegionName} • iNat: 20km Radius around ${coordsText}`;
                    if (ebirdListsItem) ebirdListsItem.style.display = 'block';
                    if (ebirdSppItem) ebirdSppItem.style.display = 'block';
                } else {
                    scopeText.innerText = `iNaturalist: 20km Radius Around ${coordsText} (${currentRegionName || 'Detected Area'})`;
                    if (ebirdListsItem) ebirdListsItem.style.display = 'none';
                    if (ebirdSppItem) ebirdSppItem.style.display = 'none';
                }
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
        const MAX_DAYS = 30; // Look back up to a month

        try {
            const hasEbirdKey = !!localStorage.getItem('ebird_api_key');
            while (itemsFound === 0 && daysTried < MAX_DAYS) {
                console.log(`Loading sightings for: ${lastLoadedDate.toDateString()}`);
                
                let ebirdPromise;
                if (hasEbirdKey) {
                    if (currentRegion) {
                        ebirdPromise = window.ebird.getRecentChecklists(currentRegion, lastLoadedDate)
                            .then(data => groupChecklists(data).map(list => {
                                const dateStr = list.obsTime ? `${list.obsDt} ${list.obsTime}` : list.obsDt;
                                return {
                                    source: 'ebird',
                                    id: list.subId,
                                    date: new Date(dateStr.replace(/-/g, "/")),
                                    ...list
                                };
                            }));
                    } else {
                        // Fallback: Coordinate-based observations
                        const daysBack = Math.ceil((new Date() - lastLoadedDate) / (1000 * 60 * 60 * 24)) + 1;
                        ebirdPromise = window.ebird.getNearbyObservations(currentCoords.lat, currentCoords.lng, 20, daysBack)
                            .then(data => groupEbirdObservations(data));
                    }
                } else {
                    ebirdPromise = Promise.resolve([]);
                }

                // One source failing shouldn't stall pagination
                ebirdPromise = ebirdPromise.catch(err => {
                    console.warn("eBird page unavailable, continuing with iNaturalist:", err);
                    return [];
                });

                const [normalizedEbird, inatData] = await Promise.all([
                    ebirdPromise,
                    window.inat.fetchObservations(currentCoords.lat, currentCoords.lng, 20, lastLoadedDate)
                ]);

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

                    allFeedItems.push(...combinedFeed);
                    refreshMap(false);

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

                    // 0.5 Media summary — assets live on Macaulay Library, which no
                    // longer allows third-party fetching, so link out to eBird instead.
                    const mt = effortInfo && effortInfo.mediaTotals;
                    if (mt && (mt.photos || mt.audio || mt.video)) {
                        const bits = [];
                        if (mt.photos) bits.push(`📷 ${mt.photos} photo${mt.photos > 1 ? 's' : ''}`);
                        if (mt.audio) bits.push(`🔈 ${mt.audio} recording${mt.audio > 1 ? 's' : ''}`);
                        if (mt.video) bits.push(`🎥 ${mt.video} video${mt.video > 1 ? 's' : ''}`);
                        html += `
                            <div class="effort-summary">
                                <a href="https://ebird.org/checklist/${subId}" target="_blank" class="effort-pill" style="text-decoration: none; color: inherit;">
                                    ${bits.join(' · ')} — view on eBird ↗
                                </a>
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
        }
        // eBird media is no longer fetchable: Macaulay Library retired its open
        // search API (the v2 replacement is CORS-blocked and bot-protected, with
        // no key program). Checklists with media get a "view on eBird" link in
        // the species list instead, via mediaCounts from the eBird checklist API.

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

    // --- Map Tab ---
    const tabFeed = document.getElementById('tab-feed');
    const tabMap = document.getElementById('tab-map');
    const mapView = document.getElementById('map-view');
    const feedLayout = document.querySelector('.feed-layout');
    let map = null;
    let mapMarkers = null;
    let mapLoadingEl = null;
    let mapFetchTimer = null;
    let mapFetchSeq = 0;
    const extraMapItems = new Map(); // sightings fetched by panning, beyond the feed

    tabFeed.addEventListener('click', () => switchTab('feed'));
    tabMap.addEventListener('click', () => switchTab('map'));

    function switchTab(which) {
        const isMap = which === 'map';
        tabFeed.classList.toggle('active', !isMap);
        tabMap.classList.toggle('active', isMap);
        feedLayout.style.display = isMap ? 'none' : '';
        mapView.style.display = isMap ? 'block' : 'none';
        if (isMap) {
            initMap();
            renderMapMarkers();
            // Leaflet measures its container on init; re-measure now that it's visible
            setTimeout(() => {
                map.invalidateSize();
                fetchVisibleSightings();
            }, 50);
        }
    }

    function initMap() {
        if (map) return;
        const center = currentCoords ? [currentCoords.lat, currentCoords.lng] : [39.8, -98.6];
        map = L.map('map').setView(center, currentCoords ? 10 : 4);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);
        mapMarkers = L.layerGroup().addTo(map);

        const legend = L.control({ position: 'bottomleft' });
        legend.onAdd = () => {
            const div = L.DomUtil.create('div', 'map-legend');
            div.innerHTML = `
                <span><i style="background:#16a34a"></i>eBird checklist</span>
                <span><i style="background:#f59e0b"></i>iNaturalist</span>`;
            return div;
        };
        legend.addTo(map);

        const loading = L.control({ position: 'topright' });
        loading.onAdd = () => {
            mapLoadingEl = L.DomUtil.create('div', 'map-loading');
            mapLoadingEl.innerText = 'Loading sightings…';
            mapLoadingEl.style.display = 'none';
            return mapLoadingEl;
        };
        loading.addTo(map);

        // Pull in sightings for wherever the user pans or zooms
        map.on('moveend', () => {
            clearTimeout(mapFetchTimer);
            mapFetchTimer = setTimeout(fetchVisibleSightings, 500);
        });
    }

    async function fetchVisibleSightings() {
        if (!map) return;
        const seq = ++mapFetchSeq;
        const center = map.getCenter();
        const bounds = map.getBounds();
        // Radius (km) from center to a corner; eBird caps dist at 50 km
        const cornerKm = Math.ceil(center.distanceTo(bounds.getNorthEast()) / 1000);
        const radiusKm = Math.max(1, Math.min(50, cornerKm));
        const hasKey = !!localStorage.getItem('ebird_api_key');

        if (mapLoadingEl) mapLoadingEl.style.display = 'block';
        try {
            const [ebirdObs, inatObs] = await Promise.all([
                hasKey
                    ? window.ebird.getNearbyObservations(center.lat, center.lng, radiusKm, 7)
                        .catch(err => { console.warn("Map eBird fetch failed:", err); return []; })
                    : Promise.resolve([]),
                window.inat.fetchObservations(center.lat, center.lng, radiusKm, null)
                    .catch(err => { console.warn("Map iNat fetch failed:", err); return []; })
            ]);
            if (seq !== mapFetchSeq) return; // superseded by a newer pan

            groupEbirdObservations(ebirdObs).forEach(item => {
                if (!extraMapItems.has(item.id)) extraMapItems.set(item.id, item);
            });
            groupInatObservations(inatObs).forEach(item => {
                if (!extraMapItems.has(item.id)) extraMapItems.set(item.id, item);
            });
            renderMapMarkers();
        } finally {
            if (seq === mapFetchSeq && mapLoadingEl) mapLoadingEl.style.display = 'none';
        }
    }

    function renderMapMarkers() {
        if (!mapMarkers) return;
        mapMarkers.clearLayers();
        // Feed items first — they carry real usernames; panned-in extras fill the rest
        const plotted = new Set();
        const items = [...allFeedItems, ...extraMapItems.values()].filter(item => {
            if (plotted.has(item.id)) return false;
            plotted.add(item.id);
            return true;
        });
        items.forEach(item => {
            const lat = item.loc && item.loc.latitude;
            const lng = item.loc && item.loc.longitude;
            if (lat == null || lng == null) return;

            const isInat = item.source === 'inaturalist';
            const marker = L.circleMarker([lat, lng], {
                radius: 8,
                weight: 2,
                color: '#ffffff',
                fillColor: isInat ? '#f59e0b' : '#16a34a',
                fillOpacity: 0.9
            });

            const dateStr = item.date.toLocaleString([], {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
            });
            const count = isInat
                ? `🌿 ${item.numSpecies} observation${item.numSpecies > 1 ? 's' : ''}`
                : `🐦 ${item.numSpecies} species`;
            const link = isInat ? '' : `<br><a href="https://ebird.org/checklist/${item.id}" target="_blank">View checklist ↗</a>`;
            marker.bindPopup(`
                <div class="map-popup">
                    <b>${item.userDisplayName || 'Observer'}</b><br>
                    ${dateStr} • ${item.locName}<br>
                    ${count}${link}
                </div>`);
            mapMarkers.addLayer(marker);
        });
    }

    // Called whenever feed data changes; recenter only on a full reload
    function refreshMap(recenter) {
        if (!map) return;
        renderMapMarkers();
        if (recenter && currentCoords) {
            map.setView([currentCoords.lat, currentCoords.lng], 10);
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
