import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

export default class LunarAnimes extends Connector {

    constructor() {
        super();
        super.id = 'lunaranimes';
        super.label = 'Lunar Animes';
        this.tags = ['manga', 'manhwa', 'manhua', 'multi-lingual', 'aggregator'];
        this.url = 'https://lunarx.to';
        this.apiUrl = 'https://api.lunarx.to';
        this.cdnUrl = 'https://vault.lunarx.to';
        this.requestOptions.headers.set('x-referer', this.url + '/');

        // Rate limiter: max 2 concurrent requests, 300ms delay between requests
        // (mirrors keiyoushi rateLimit(2) for api/cdn hosts in LunarAnime.kt)
        this._maxConcurrent = 2;
        this._activeRequests = 0;
        this._requestQueue = [];
        this._requestDelay = 300;
        this._needsDpop = false;
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

    async _rateLimitedFetchJSON(url, options) {
        await this._acquireSlot();
        try {
            const request = new Request(url, options || this.requestOptions);
            return await this._fetchJSONWithDpop(request);
        } finally {
            this._releaseSlot();
        }
    }

    /**
     * Port of LunarWebViewSigner.dpopInterceptor():
     * normal API request, on 403 with body containing "validate" retry once
     * with a DPoP header signed by the site's IndexedDB key.
     */
    async _fetchJSONWithDpop(request) {
        let response = await fetch(request.clone());
        if (response.status !== 403) {
            if (!response.ok) {
                throw new Error(`Failed to receive content from "${request.url}" (status: ${response.status}) - ${response.statusText}`);
            }
            return await response.json();
        }
        let body = '';
        try {
            body = await response.clone().text();
        } catch (e) { /* ignore */ }
        if (!/validate/i.test(body)) {
            throw new Error(`Failed to receive content from "${request.url}" (status: 403) - Forbidden`);
        }
        // First 403+validate: enable DPoP for subsequent API calls (like needsCaptcha in Kotlin)
        this._needsDpop = true;
        const dpop = await this._signDpop(request.method || 'GET', request.url.split('?')[0]).catch(() => '');
        if (!dpop) {
            throw new Error('Solve captcha in webview and retry');
        }
        const retry = new Request(request.clone());
        retry.headers.set('dpop', dpop);
        response = await fetch(retry);
        if (!response.ok) {
            throw new Error(`Failed to receive content from "${request.url}" (status: ${response.status}) - ${response.statusText}`);
        }
        return await response.json();
    }

    /**
     * Port of LunarWebViewSigner.buildJs(): runs in site origin (via fetchUI)
     * so IndexedDB "dbinfo" with the ES256 keypair is accessible.
     */
    async _signDpop(method, htu) {
        const script = `
            (async () => {
                function b64url(str) {
                    return btoa(str).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
                }
                function bytes(str) {
                    return new TextEncoder().encode(str);
                }
                function randJti() {
                    return b64url(String.fromCharCode.apply(null, crypto.getRandomValues(new Uint8Array(16))));
                }
                function encode(obj) {
                    return b64url(JSON.stringify(obj));
                }
                function loadKey() {
                    return new Promise((resolve, reject) => {
                        const req = indexedDB.open("dbinfo");
                        req.onsuccess = function(e) {
                            const db = e.target.result;
                            try {
                                const storeNames = Array.from(db.objectStoreNames);
                                let found = false;
                                let checked = 0;
                                if (storeNames.length === 0) {
                                    db.close();
                                    reject(new Error('no stores'));
                                    return;
                                }
                                for (const storeName of storeNames) {
                                    const tx = db.transaction(storeName, "readonly");
                                    const store = tx.objectStore(storeName);
                                    function fallbackScan() {
                                        let getAllReq;
                                        try {
                                            getAllReq = store.getAll();
                                        } catch (err) {
                                            checked++;
                                            if (checked === storeNames.length && !found) {
                                                db.close();
                                                reject(err);
                                            }
                                            return;
                                        }
                                        getAllReq.onsuccess = function() {
                                            const items = getAllReq.result || [];
                                            for (const item of items) {
                                                if (item && item.privateKey && item.publicJwk) {
                                                    found = true;
                                                    db.close();
                                                    resolve(item);
                                                    return;
                                                }
                                            }
                                            checked++;
                                            if (checked === storeNames.length && !found) {
                                                db.close();
                                                reject(new Error('no key'));
                                            }
                                        };
                                        getAllReq.onerror = function() {
                                            checked++;
                                            if (checked === storeNames.length && !found) {
                                                db.close();
                                                reject(new Error('no key'));
                                            }
                                        };
                                    }
                                    let metaReq;
                                    try {
                                        metaReq = store.get("sw-cache-meta");
                                    } catch (err) {
                                        fallbackScan();
                                        continue;
                                    }
                                    metaReq.onsuccess = function() {
                                        const meta = metaReq.result;
                                        let activeId = null;
                                        if (meta && typeof meta === 'object' && Array.isArray(meta.ids) &&
                                            typeof meta.sel === 'number' && meta.sel >= 0 && meta.sel < meta.ids.length) {
                                            activeId = meta.ids[meta.sel];
                                        }
                                        if (activeId) {
                                            const keyReq = store.get(activeId);
                                            keyReq.onsuccess = function() {
                                                const keyData = keyReq.result;
                                                if (keyData && keyData.privateKey && keyData.publicJwk) {
                                                    found = true;
                                                    db.close();
                                                    resolve(keyData);
                                                    return;
                                                }
                                                fallbackScan();
                                            };
                                            keyReq.onerror = fallbackScan;
                                        } else {
                                            fallbackScan();
                                        }
                                    };
                                    metaReq.onerror = fallbackScan;
                                }
                            } catch (err) {
                                try { db.close(); } catch (_) {}
                                reject(err);
                            }
                        };
                        req.onerror = function() {
                            reject(new Error('indexedDB open failed'));
                        };
                    });
                }
                const keyPair = await loadKey();
                const header = { typ: "dpop+jwt", alg: "ES256", jwk: keyPair.publicJwk };
                const payload = { htm: ${JSON.stringify(method)}, htu: ${JSON.stringify(htu)}, iat: Math.floor(Date.now() / 1000), jti: randJti() };
                const h = encode(header);
                const p = encode(payload);
                const input = h + "." + p;
                const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, bytes(input));
                const s = b64url(String.fromCharCode.apply(null, new Uint8Array(sig)));
                return input + "." + s;
            })()
        `;
        const request = new Request(this.url, this.requestOptions);
        const dpop = await Engine.Request.fetchUI(request, script, 10000, false);
        return typeof dpop === 'string' ? dpop : '';
    }

    async _apiFetch(url, init) {
        const headers = new Headers(init && init.headers || undefined);
        if (this._needsDpop && !headers.has('dpop')) {
            const method = init && init.method || 'GET';
            const dpop = await this._signDpop(method, url.split('?')[0]).catch(() => '');
            if (dpop) {
                headers.set('dpop', dpop);
            }
        }
        await this._acquireSlot();
        try {
            const request = new Request(url, {
                ...this.requestOptions,
                ...init || {},
                headers: this._mergeHeaders(this.requestOptions.headers, headers)
            });
            const response = await fetch(request);
            return response;
        } finally {
            this._releaseSlot();
        }
    }

    _mergeHeaders(base, extra) {
        const merged = new Headers(base);
        extra.forEach((value, key) => merged.set(key, value));
        return merged;
    }

    canHandleURI(uri) {
        return /https?:\/\/(lunarx\.to|lunaranime\.ru)\/manga\/[^/]+/.test(uri.href);
    }

    async _getMangaFromURI(uri) {
        const slug = uri.pathname.split('/').filter(Boolean).pop();
        try {
            const { manga } = await this._rateLimitedFetchJSON(`${this.apiUrl}/api/manga/title/${slug}`);
            return new Manga(this, slug, manga.title);
        } catch (e) {
            return new Manga(this, slug, slug);
        }
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
            totalPages = data.total_pages || data.totalPages || 1;
            page++;
        } while (page <= totalPages);
        return allMangas;
    }

    async _getChapters(manga) {
        const [passwordInfo, chapterList] = await Promise.all([
            this._rateLimitedFetchJSON(`${this.apiUrl}/api/manga/password/info/${manga.id}`),
            this._rateLimitedFetchJSON(`${this.apiUrl}/api/manga/${manga.id}`),
        ]);

        // Kotlin: LunarPasswordInfoResponse(has_series_password, chapter_passwords)
        const hasSeriesPassword = passwordInfo.has_series_password !== undefined ? passwordInfo.has_series_password : passwordInfo.hasSeriesPassword !== undefined ? passwordInfo.hasSeriesPassword : false;
        const chapterPasswords = passwordInfo.chapter_passwords !== undefined ? passwordInfo.chapter_passwords : passwordInfo.chapterPasswords || [];

        const chapters = chapterList.data.map(chapter => {
            const language = chapter.language;
            // Kotlin compares chapter_number (String) with chapter.chapter
            const num = chapter.chapter;
            const isLocked = hasSeriesPassword || chapterPasswords.some(
                cp => (cp.chapter_number !== undefined ? cp.chapter_number : cp.chapterNumber) === num && (cp.language == null || cp.language === language)
            );

            const chapterName = num.replace(/\.00$/, '').replace(/\.0$/, '');
            const chapterNum = `Chapter ${chapterName}`;
            const chapterTitle = chapter.chapter_title !== undefined ? chapter.chapter_title : chapter.chapterTitle;
            const titleText = chapterTitle && chapterTitle.trim();

            let title;
            if (!titleText) {
                title = chapterNum;
            } else if (
                titleText.toLowerCase().includes(chapterNum.toLowerCase()) ||
                titleText.toLowerCase().includes(`ch.${chapterName}`.toLowerCase()) ||
                titleText.toLowerCase().includes('volume') ||
                titleText.toLowerCase().includes('vol.')
            ) {
                title = titleText;
            } else {
                title = `${chapterNum}: ${titleText}`;
            }

            if (isLocked) {
                title = `🔒 ${title}`;
            }

            return {
                id: JSON.stringify({ slug: manga.id, chapter: num, lang: language, locked: isLocked }),
                title: title,
                language: language,
            };
        });
        // Kotlin: fetchChapterList().map { ... }.reversed()
        return chapters.reverse();
    }

    /**
     * Port of LunarAnime.viewChapter(): required requests, otherwise fake images are returned.
     * GET /api/manga/rating/status/{slug}/{number}
     * POST /api/manga/chapter/view { slug, chapter, language }
     */
    async _viewChapter(slug, number, lang) {
        try {
            const statusRes = await this._apiFetch(`${this.apiUrl}/api/manga/rating/status/${slug}/${number}`);
            try {
                await statusRes.arrayBuffer();
            } catch (e) { /* drain */ }
        } catch (e) { /* non-fatal */ }
        try {
            await this._apiFetch(`${this.apiUrl}/api/manga/chapter/view`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ slug: slug, chapter: number, language: lang })
            }).then(async res => {
                try {
                    await res.arrayBuffer();
                } catch (e) { /* drain */ }
            });
        } catch (e) { /* non-fatal */ }
    }

    async _getPages(chapter) {
        const chapterInfo = JSON.parse(chapter.id);

        if (chapterInfo.locked) {
            throw new Error('Chapter is password-protected and cannot be downloaded.');
        }

        const chapterUrl = `${this.url}/manga/${chapterInfo.slug}/${chapterInfo.chapter}?lang=${chapterInfo.lang}`;
        const request = new Request(chapterUrl, this.requestOptions);
        const response = await fetch(request);
        if (!response.ok) {
            throw new Error(`Failed to fetch chapter page: ${response.status} ${response.statusText}`);
        }
        const html = await response.text();

        // Required requests or fake images are returned (see LunarAnime.fetchPageList)
        await this._viewChapter(chapterInfo.slug, chapterInfo.chapter, chapterInfo.lang);

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
        } else if (data && data.sessionData) {
            images = this._decryptSessionImages(data.sessionData, rctx0);
        } else if (data && data.images) {
            images = data.images;
        } else {
            images = [];
        }

        return images.map(url => {
            // Kotlin imageRequest(): Referer = chapter page; interceptor overwrites
            // CDN host referer to baseUrl/ (Node 16 compatible, no URL parsing pitfalls)
            let referer = chapterUrl;
            try {
                if (new URL(url).hostname !== new URL(this.url).hostname) {
                    referer = this.url + '/';
                }
            } catch (e) {
                referer = this.url + '/';
            }
            return this.createConnectorURI({ url, referer });
        });
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
            pushRegex.lastIndex = 0;
            while ((pushMatch = pushRegex.exec(text)) !== null) {
                const decoded = pushMatch[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"');
                let dictMatch;
                dictRegex.lastIndex = 0;
                while ((dictMatch = dictRegex.exec(decoded)) !== null) {
                    try {
                        const obj = JSON.parse(dictMatch[0]);
                        // Kotlin: parseAs<Map<String, String>>() + keys.any { it.length == 2 }
                        if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)
                            && Object.keys(obj).some(k => k.length === 2)
                            && Object.values(obj).every(v => typeof v === 'string')) {
                            seeds.push(obj);
                        }
                    } catch (e) { /* skip */ }
                }
            }
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
            const xorByte = xorKey + i / 2 * 7 + 3 & 0xFF;
            aStr += String.fromCharCode(hexByte ^ xorByte);
        }
        if (!aStr) return '';

        // Kotlin: Random(aStr.length.toLong()) => XorWowRandom, NOT java.util.Random
        const rand = new KotlinRandom(aStr.length);

        const h = Array.from({ length: 256 }, (_, i) => i);
        for (let i = 255; i >= 1; i--) {
            const j = rand.nextInt(i + 1);
            const tmp = h[i]; h[i] = h[j]; h[j] = tmp;
        }

        const s = new Array(256);
        for (let i = 0; i < 256; i++) s[h[i]] = i;

        const u = Array.from({ length: aStr.length }, () => rand.nextInt(256));

        const d = aStr.split('').map(c => c.charCodeAt(0) & 0xFF);

        for (let round = 0; round < 3; round++) {
            for (let t = 0; t < d.length; t++) {
                d[t] = d[t] ^ u[(t + 7 * round) % u.length];
                d[t] = h[d[t]];
                const shift = (t + 3 * round + 1) % 7 + 1;
                d[t] = (d[t] << shift | d[t] >>> 8 - shift) & 0xFF;
            }
            for (let t = 1; t < d.length; t++) d[t] = d[t] ^ d[t - 1];
        }

        const e = d.slice();
        for (let round = 2; round >= 0; round--) {
            for (let t = e.length - 1; t >= 1; t--) e[t] = e[t] ^ e[t - 1];
            for (let t = 0; t < e.length; t++) {
                const shift = (t + 3 * round + 1) % 7 + 1;
                e[t] = (e[t] >>> shift | e[t] << 8 - shift) & 0xFF;
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
        // Kotlin imageRequest(): Accept image/avif,image/webp,...
        request.headers.set('Accept', 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8');
        const response = await fetch(request);
        const data = await response.blob();
        return this._blobToBuffer(data);
    }
}

/**
 * Port of kotlin.random.Random(seed: Long) => XorWowRandom.
 * Random(seed) = XorWowRandom(seed.toInt(), seed.shr(32).toInt())
 * XorWowRandom(seed1, seed2) = (seed1, seed2, 0, 0, seed1.inv(), (seed1 shl 10) xor (seed2 ushr 4))
 * then 64x nextInt() warmup. All Int ops wrap at 32-bit.
 */
class KotlinRandom {
    constructor(seed) {
        const seed1 = seed | 0;
        const seed2 = Math.floor(seed / 4294967296) | 0;
        this.x = seed1;
        this.y = seed2;
        this.z = 0;
        this.w = 0;
        this.v = ~seed1;
        this.addend = seed1 << 10 ^ seed2 >>> 4 | 0;
        for (let i = 0; i < 64; i++) this.nextInt32();
    }
    nextInt32() {
        let t = this.x;
        t = t ^ t >>> 2 | 0;
        this.x = this.y;
        this.y = this.z;
        this.z = this.w;
        const v0 = this.v;
        this.w = v0;
        t = (t ^ (t << 1 | 0) | 0) ^ v0 ^ (v0 << 4 | 0) | 0;
        this.v = t;
        this.addend = this.addend + 362437 | 0;
        return t + this.addend | 0;
    }
    _takeUpperBits(value, bitCount) {
        // Int.takeUpperBits: ushr(32 - bitCount) and (-bitCount).shr(31)
        if (bitCount === 0) return 0;
        return (value >>> 32 - bitCount | 0) & (-bitCount >> 31 | 0) | 0;
    }
    nextBits(bitCount) {
        return this._takeUpperBits(this.nextInt32(), bitCount);
    }
    _fastLog2(value) {
        return 31 - Math.clz32(value);
    }
    nextInt(bound) {
        if (bound <= 0) throw new Error('Random range is empty');
        const n = bound | 0;
        let rnd;
        if ((n & -n) === n) {
            rnd = this.nextBits(this._fastLog2(n));
        } else {
            let v;
            let bits;
            do {
                bits = this.nextInt32() >>> 1;
                v = bits % n;
                // signed 32-bit overflow check like Kotlin: bits - v + (n - 1) < 0
            } while ((bits - v + (n - 1) | 0) < 0);
            rnd = v;
        }
        return rnd;
    }
}
