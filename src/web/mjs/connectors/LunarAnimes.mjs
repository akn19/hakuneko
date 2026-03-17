import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

export default class LunarAnimes extends Connector {

    constructor() {
        super();
        super.id = 'lunaranimes';
        super.label = 'Lunar Animes';
        this.tags = ['manga', 'manhwa', 'manhua', 'multi-lingual', 'aggregator'];
        this.url = 'https://lunaranime.ru';
        this.apiUrl = 'https://api.lunaranime.ru';
        this.requestOptions.headers.set('x-referer', this.url + '/');

        // Rate limiter: max 2 concurrent requests, 300ms delay between requests
        this._maxConcurrent = 2;
        this._activeRequests = 0;
        this._requestQueue = [];
        this._requestDelay = 300;
    }

    async _acquireSlot() {
        while (this._activeRequests >= this._maxConcurrent) {
            await new Promise(resolve => this._requestQueue.push(resolve));
        }
        this._activeRequests++;
        await this.wait(this._requestDelay);
    }

    _releaseSlot() {
        this._activeRequests--;
        const next = this._requestQueue.shift();
        if (next) next();
    }

    async _rateLimitedFetchJSON(url) {
        await this._acquireSlot();
        try {
            const request = new Request(url, this.requestOptions);
            return await this.fetchJSON(request);
        } finally {
            this._releaseSlot();
        }
    }

    canHandleURI(uri) {
        return /https?:\/\/lunaranime\.ru\/manga\/[^/]+/.test(uri.href);
    }

    async _getMangaFromURI(uri) {
        const slug = uri.pathname.split('/').filter(Boolean).pop();
        const { manga } = await this._rateLimitedFetchJSON(`${this.apiUrl}/api/manga/title/${slug}`);
        return new Manga(this, slug, manga.title);
    }

    async _getMangas() {
        let allMangas = [];
        let page = 1;
        let totalPages = 1;
        do {
            const data = await this._rateLimitedFetchJSON(`${this.apiUrl}/api/manga/search?page=${page}&limit=30&sort=relevance`);
            allMangas.push(...data.manga.map(entry => ({
                id: entry.slug,
                title: entry.title,
            })));
            totalPages = data.total_pages || 1;
            page++;
        } while (page <= totalPages);
        return allMangas;
    }

    async _getChapters(manga) {
        const { data } = await this._rateLimitedFetchJSON(`${this.apiUrl}/api/manga/${manga.id}`);
        return data.map(chapter => {
            const num = chapter.chapter;
            const title = chapter.chapter_title && chapter.chapter_title.trim();
            const isRedundant = !title || /^chapter\s+/i.test(title);
            return {
                id: `${manga.id}/${num}?lang=${chapter.language}`,
                title: isRedundant ? `Chapter ${num}` : `Chapter ${num} - ${title}`,
                language: chapter.language,
            };
        });
    }

    async _getPages(chapter) {
        const { data } = await this._rateLimitedFetchJSON(`${this.apiUrl}/api/manga/${chapter.id}`);

        let images;
        if (data && data.session_data) {
            const chapterPath = chapter.id.split('?')[0];
            const secretKey = await this._getSecretKey(chapterPath);
            if (!secretKey) {
                throw new Error('Failed to extract secret key for page decryption');
            }
            const key = CryptoJS.SHA256(secretKey);
            const iv = CryptoJS.lib.WordArray.create(new Uint8Array(16));
            const decrypted = CryptoJS.AES.decrypt(data.session_data, key, {
                iv: iv,
                mode: CryptoJS.mode.CBC,
                padding: CryptoJS.pad.Pkcs7
            });
            const decryptedData = JSON.parse(decrypted.toString(CryptoJS.enc.Utf8));
            images = decryptedData.data.images;
        } else if (data && data.images) {
            images = data.images;
        } else {
            images = [];
        }

        return images.map(url => this.createConnectorURI({ url, referer: this.url + '/' }));
    }

    async _getSecretKey(chapterPath) {
        const request = new Request(`${this.url}/manga/${chapterPath}`, this.requestOptions);
        const script = `
            new Promise((resolve) => {
                // Helper: recursively search an object for secretKey
                const findKey = (obj, depth) => {
                    if (depth > 10 || !obj || typeof obj !== 'object') return null;
                    if (typeof obj.secretKey === 'string') return obj.secretKey;
                    for (const v of Object.values(obj)) {
                        const r = findKey(v, depth + 1);
                        if (r) return r;
                    }
                    return null;
                };

                // Method 1: Next.js App Router - self.__next_f flight data
                if (typeof self !== 'undefined' && Array.isArray(self.__next_f)) {
                    for (const chunk of self.__next_f) {
                        if (!Array.isArray(chunk) || chunk.length < 2 || typeof chunk[1] !== 'string') continue;
                        // RSC flight data: each line is "id:JSON_VALUE"
                        const lines = chunk[1].split('\\n');
                        for (const line of lines) {
                            const colonIdx = line.indexOf(':');
                            if (colonIdx < 0) continue;
                            const jsonPart = line.substring(colonIdx + 1);
                            try {
                                const parsed = JSON.parse(jsonPart);
                                const k = findKey(parsed, 0);
                                if (k) return resolve(k);
                            } catch (e) {}
                        }
                        // Also try raw regex on the chunk string
                        const m = chunk[1].match(/"secretKey"\\s*:\\s*"([^"]+)"/);
                        if (m) return resolve(m[1]);
                    }
                }

                // Method 2: Next.js Pages Router - __NEXT_DATA__
                if (typeof __NEXT_DATA__ !== 'undefined') {
                    const k = findKey(__NEXT_DATA__, 0);
                    if (k) return resolve(k);
                }

                // Method 3: Search all script tags for inline JSON or flight data
                for (const s of document.querySelectorAll('script')) {
                    const text = s.textContent || '';
                    // Try __next_f.push content
                    const pushes = text.matchAll(/self\\.__next_f\\.push\\(\\[\\d+,"([^"]*(?:\\\\.[^"]*)*)"\\]\\)/g);
                    for (const p of pushes) {
                        try {
                            const decoded = JSON.parse('"' + p[1] + '"');
                            const m2 = decoded.match(/"secretKey"\\s*:\\s*"([^"]+)"/);
                            if (m2) return resolve(m2[1]);
                        } catch(e) {}
                    }
                    // Direct regex
                    const m = text.match(/"secretKey"\\s*:\\s*"([^"]+)"/);
                    if (m) return resolve(m[1]);
                }

                resolve(null);
            });
        `;
        return await Engine.Request.fetchUI(request, script);
    }

    async _handleConnectorURI(payload) {
        const request = new Request(payload.url, this.requestOptions);
        request.headers.set('x-referer', payload.referer);
        const response = await fetch(request);
        const data = await response.blob();
        return this._blobToBuffer(data);
    }
}
