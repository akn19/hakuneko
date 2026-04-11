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
        const [passwordInfo, chapterList] = await Promise.all([
            this._rateLimitedFetchJSON(`${this.apiUrl}/api/manga/password/info/${manga.id}`),
            this._rateLimitedFetchJSON(`${this.apiUrl}/api/manga/${manga.id}`),
        ]);

        const hasSeriesPassword = passwordInfo.has_series_password || false;
        const chapterPasswords = passwordInfo.chapter_passwords || [];

        return chapterList.data.map(chapter => {
            const num = chapter.chapter;
            const isLocked = hasSeriesPassword || chapterPasswords.some(
                cp => cp.chapter_number === num && (cp.language == null || cp.language === chapter.language)
            );

            const chapterName = num.replace(/\.00$/, '').replace(/\.0$/, '');
            const chapterNum = `Chapter ${chapterName}`;
            const chapterTitle = chapter.chapter_title && chapter.chapter_title.trim();

            let title;
            if (!chapterTitle) {
                title = chapterNum;
            } else if (
                chapterTitle.toLowerCase().includes(chapterNum.toLowerCase()) ||
                chapterTitle.toLowerCase().includes(`ch.${chapterName}`.toLowerCase()) ||
                chapterTitle.toLowerCase().includes('volume') ||
                chapterTitle.toLowerCase().includes('vol.')
            ) {
                title = chapterTitle;
            } else {
                title = `${chapterNum}: ${chapterTitle}`;
            }

            if (isLocked) {
                title = `🔒 ${title}`;
            }

            return {
                id: JSON.stringify({ slug: manga.id, chapter: num, lang: chapter.language, locked: isLocked }),
                title: title,
                language: chapter.language,
            };
        });
    }

    async _getPages(chapter) {
        const chapterInfo = JSON.parse(chapter.id);

        if (chapterInfo.locked) {
            throw new Error('Chapter is password-protected and cannot be downloaded.');
        }

        const chapterUrl = `${this.url}/manga/${chapterInfo.slug}/${chapterInfo.chapter}`;
        const request = new Request(chapterUrl, this.requestOptions);
        const response = await fetch(request);
        const html = await response.text();

        const seeds = this._extractSeeds(html);
        const rctx0 = this._generateRctxFrom(seeds[0]);
        const rctx1 = this._generateRctxFrom(seeds[1]);
        const token = this._generateToken(rctx0, rctx1, chapterInfo.slug, chapterInfo.chapter);

        const { data } = await this._rateLimitedFetchJSON(
            `${this.apiUrl}/api/manga/r/${token}?lang=${chapterInfo.lang}`
        );

        let images;
        if (data && data.session_data) {
            images = this._decryptSessionImages(data.session_data, rctx0);
        } else if (data && data.images) {
            images = data.images;
        } else {
            images = [];
        }

        return images.map(url => this.createConnectorURI({ url, referer: this.url + '/' }));
    }

    _extractSeeds(html) {
        const dom = this.createDOM(html);
        const scripts = [...dom.querySelectorAll('script:not([src])')];
        const pushRegex = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
        const dictRegex = /\{[^{}]*\}/g;
        const seeds = [];

        for (const script of scripts) {
            const text = script.textContent || '';
            let pushMatch;
            while ((pushMatch = pushRegex.exec(text)) !== null) {
                const decoded = pushMatch[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"');
                let dictMatch;
                dictRegex.lastIndex = 0;
                while ((dictMatch = dictRegex.exec(decoded)) !== null) {
                    try {
                        const obj = JSON.parse(dictMatch[0]);
                        if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)
                            && Object.values(obj).every(v => typeof v === 'string')
                            && Object.keys(obj).some(k => k.length === 2)) {
                            seeds.push(obj);
                        }
                    } catch (e) { /* skip */ }
                }
            }
            pushRegex.lastIndex = 0;
        }

        if (seeds.length < 2) {
            throw new Error('Failed to find payload seeds from RSC flight data');
        }
        return seeds;
    }

    _generateRctxFrom(seedObj) {
        const shortKeyEntry = Object.entries(seedObj).find(([k]) => k.length === 2);
        if (!shortKeyEntry) throw new Error('No 2-char key found in seed object');
        const reversedB64 = shortKeyEntry[1].split('').reverse().join('');

        const padded = reversedB64.padEnd(Math.ceil(reversedB64.length / 4) * 4, '=');
        const decoded = atob(padded);
        const parts = decoded.split('.');
        const xorKey = parseInt(parts[0], 16);
        const hexStr = parts.slice(1).map(k => seedObj[k] || '').join('');

        let aStr = '';
        for (let i = 0; i < hexStr.length; i += 2) {
            const hexByte = parseInt(hexStr.substring(i, i + 2), 16);
            const xorByte = (xorKey + (i / 2) * 7 + 3) & 0xFF;
            aStr += String.fromCharCode(hexByte ^ xorByte);
        }
        if (!aStr) return '';

        const rand = new JavaRandom(aStr.length);

        const h = Array.from({ length: 256 }, (_, i) => i);
        for (let i = 255; i >= 1; i--) {
            const j = rand.nextInt(i + 1);
            const tmp = h[i]; h[i] = h[j]; h[j] = tmp;
        }

        const s = new Array(256);
        for (let i = 0; i < 256; i++) s[h[i]] = i;

        const u = Array.from({ length: aStr.length }, () => rand.nextInt(256));

        const d = aStr.split('').map(c => c.charCodeAt(0));

        for (let round = 0; round < 3; round++) {
            for (let t = 0; t < d.length; t++) {
                d[t] = d[t] ^ u[(t + 7 * round) % u.length];
                d[t] = h[d[t]];
                const shift = (t + 3 * round + 1) % 7 + 1;
                d[t] = ((d[t] << shift) | (d[t] >>> (8 - shift))) & 0xFF;
            }
            for (let t = 1; t < d.length; t++) d[t] = d[t] ^ d[t - 1];
        }

        const e = d.slice();
        for (let round = 2; round >= 0; round--) {
            for (let t = e.length - 1; t >= 1; t--) e[t] = e[t] ^ e[t - 1];
            for (let t = 0; t < e.length; t++) {
                const shift = (t + 3 * round + 1) % 7 + 1;
                e[t] = ((e[t] >>> shift) | (e[t] << (8 - shift))) & 0xFF;
                e[t] = s[e[t]];
                e[t] = e[t] ^ u[(t + 7 * round) % u.length];
            }
        }

        return e.map(b => String.fromCharCode(b)).join('');
    }

    _generateToken(rctx0, rctx1, slug, index) {
        const maxLen = Math.max(rctx0.length, rctx1.length);
        const xorKey = new Uint8Array(maxLen);
        for (let i = 0; i < maxLen; i++) {
            xorKey[i] = (rctx0.charCodeAt(i % rctx0.length) ^ rctx1.charCodeAt(i % rctx1.length)) & 0xFF;
        }

        const timestamp = Math.floor(Date.now() / 1000).toString(16);
        const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let rand = '';
        for (let i = 0; i < 8; i++) {
            rand += alphabet[Math.floor(Math.random() * alphabet.length)];
        }

        const payload = `${timestamp}|${rand}|${slug}|${index}`;
        const encrypted = new Uint8Array(payload.length);
        for (let i = 0; i < payload.length; i++) {
            encrypted[i] = payload.charCodeAt(i) ^ xorKey[i % xorKey.length];
        }

        const binaryStr = String.fromCharCode(...encrypted);
        return btoa(binaryStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    _decryptSessionImages(sessionDataB64, rctx0) {
        const b64 = sessionDataB64.replace(/-/g, '+').replace(/_/g, '/');
        const padLen = Math.ceil(b64.length / 4) * 4;
        const paddedB64 = b64.padEnd(padLen, '=');

        const ciphertext = CryptoJS.enc.Base64.parse(paddedB64);
        const key = CryptoJS.SHA256(rctx0);
        const iv = CryptoJS.lib.WordArray.create(new Uint8Array(16));

        const decrypted = CryptoJS.AES.decrypt(
            { ciphertext: ciphertext },
            key,
            { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
        );

        const decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
        const parsed = JSON.parse(decryptedText);
        return parsed.data.images;
    }

    async _handleConnectorURI(payload) {
        const request = new Request(payload.url, this.requestOptions);
        request.headers.set('x-referer', payload.referer);
        const response = await fetch(request);
        const data = await response.blob();
        return this._blobToBuffer(data);
    }
}

class JavaRandom {
    constructor(seed) {
        this._seed = (BigInt(seed) ^ 0x5DEECE66Dn) & 0xFFFFFFFFFFFFn;
    }
    _next(bits) {
        this._seed = (this._seed * 0x5DEECE66Dn + 0xBn) & 0xFFFFFFFFFFFFn;
        return Number(this._seed >> BigInt(48 - bits));
    }
    nextInt(bound) {
        if ((bound & (bound - 1)) === 0) {
            return Number((BigInt(bound) * BigInt(this._next(31))) >> 31n);
        }
        let bits, val;
        do {
            bits = this._next(31);
            val = bits % bound;
        } while (((bits - val + (bound - 1)) | 0) < 0);
        return val;
    }
}
