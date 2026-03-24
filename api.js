/**
 * eBird API Service Layer
 */

const EBIRD_BASE_URL = 'https://api.ebird.org/v2';

class EbirdService {
    constructor(apiKey = null) {
        this.apiKey = apiKey;
        this.taxonomyMap = new Map();
        this.isLoadingTaxonomy = false;
    }

    setApiKey(key) {
        this.apiKey = key;
    }

    async fetchJson(endpoint, params = {}) {
        const url = new URL(`${EBIRD_BASE_URL}${endpoint}`);
        Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));

        const headers = {
            'X-eBirdApiToken': this.apiKey
        };

        const response = await fetch(url, { headers });
        if (!response.ok) {
            throw new Error(`eBird API error: ${response.statusText}`);
        }
        return response.json();
    }

    /**
     * Fetch taxonomy for a region (e.g. US-ME) and cache it
     */
    async loadTaxonomy(regionCode) {
        if (this.isLoadingTaxonomy) return;
        this.isLoadingTaxonomy = true;
        
        try {
            // Get state code (e.g., US-ME-009 -> US-ME)
            const stateCode = regionCode.split('-').slice(0, 2).join('-');
            console.log(`Loading taxonomy for ${stateCode}...`);
            
            // Note: For simplicity, fetching some recent obs first as a 'hot cache'
            // because state-wide taxonomy is large.
            const recentObs = await this.fetchJson(`/data/obs/${regionCode}/recent`, { back: 14 });
            recentObs.forEach(obs => {
                this.taxonomyMap.set(obs.speciesCode, obs.comName);
            });
            
            // If we have a key, we can try to fetch more if needed, 
            // but recentObs handles 90% of feed items instantly.
        } catch (e) {
            console.warn("Fast taxonomy load failed, falling back to basic mapping:", e);
        } finally {
            this.isLoadingTaxonomy = false;
        }
    }

    getSpeciesName(speciesCode) {
        return this.taxonomyMap.get(speciesCode) || speciesCode;
    }

    /**
     * Get recent checklists for a region, optionally for a specific date
     */
    async getRecentChecklists(regionCode, date = null) {
        if (!this.apiKey) return this.getMockChecklists();
        
        let endpoint = `/product/lists/${regionCode}`;
        let params = { maxResults: 100 };
        
        if (date) {
            const y = date.getFullYear();
            const m = date.getMonth() + 1;
            const d = date.getDate();
            endpoint = `/product/lists/${regionCode}/${y}/${m}/${d}`;
        }
        
        const checklists = await this.fetchJson(endpoint, params);
        
        // Ensure locName exists for the feed
        return checklists.map(c => ({
            ...c,
            // Try different possible locName keys
            locName: c.locName || (c.loc && c.loc.name) || c.locationName || "Unknown Location"
        }));
    }

    /**
     * Get full details for a checklist (species seen, etc.)
     */
    async getChecklistDetails(subId) {
        if (!this.apiKey) return this.getMockChecklistDetails(subId);
        try {
            const d = await this.fetchJson(`/product/checklist/view/${subId}`, { sppLocale: 'en' });
            console.log("Checklist Details Response:", d);
            
            // Very robust mapping
            return {
                subId: d.subId,
                obsDt: d.obsDt,
                obsTime: d.obsTime,
                locName: d.locName || (d.loc && d.loc.name) || "Unknown Location",
                userDisplayName: d.userDisplayName,
                obs: (d.obs || d.observations || []).map(o => ({
                    comName: this.getSpeciesName(o.speciesCode),
                    howMany: o.howMany || o.count || o.howManyStr || "1",
                    speciesCode: o.speciesCode
                }))
            };
        } catch (e) {
            console.error("Error in getChecklistDetails:", e);
            throw e;
        }
    }

    /**
     * Get recent observations in a region (alternative view)
     */
    async getRecentObservations(regionCode) {
        if (!this.apiKey) return [];
        return await this.fetchJson(`/data/obs/${regionCode}/recent`);
    }

    /**
     * Mock Data for Demo Mode
     */
    getMockChecklists() {
        return [
            {
                subId: "S12345678",
                locId: "L12345",
                locName: "Central Park - The Ramble",
                userDisplayName: "James Longo",
                obsDt: "2026-03-23 08:30",
                numSpecies: 14,
                allObsReported: true
            },
            {
                subId: "S12345679",
                locId: "L12346",
                locName: "Prospect Park",
                userDisplayName: "Elena Bird",
                obsDt: "2026-03-22 15:45",
                numSpecies: 8,
                allObsReported: true
            },
            {
                subId: "S12345680",
                locId: "L12347",
                locName: "Jamaica Bay Wildlife Refuge",
                userDisplayName: "Alex Wilson",
                obsDt: "2026-03-22 10:15",
                numSpecies: 22,
                allObsReported: true
            }
        ];
    }

    getMockChecklistDetails(subId) {
        const speciesPool = [
            { comName: "Northern Cardinal", howMany: 3 },
            { comName: "Black-capped Chickadee", howMany: 5 },
            { comName: "Blue Jay", howMany: 2 },
            { comName: "American Goldfinch", howMany: 4 },
            { comName: "Red-tailed Hawk", howMany: 1 },
            { comName: "Tufted Titmouse", howMany: 3 },
            { comName: "White-breasted Nuthatch", howMany: 2 },
            { comName: "Mourning Dove", howMany: 6 }
        ];
        
        // Shuffle and pick some
        const shuffled = [...speciesPool].sort(() => 0.5 - Math.random());
        return {
            obs: shuffled.slice(0, 4 + Math.floor(Math.random() * 3))
        };
    }
}

window.ebird = new EbirdService();
