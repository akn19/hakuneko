import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

export default class Mikoroku extends Connector {
    constructor() {
        super();
        super.id = 'mikoroku';
        super.label = 'Mikoroku';
        this.tags = [ 'manga', 'scanlation', 'indonesian' ];
        this.url = 'https://mikoroku.com';
        this.githubList = 'https://raw.githubusercontent.com/moemaomao/mymangadata/main/all-manga.json';
        this.seriesFeed = 'https://www.mikoroku.top';
        this.chapterFeed = 'https://www.mikodrive.my.id';
        this.chapterFeed2 = 'https://www.yomidays.my.id';
        this.firestore = 'https://firestore.googleapis.com/v1/projects/mikoroku/databases/(default)/documents/manga';
        this.apiKey = 'AIzaSyAi8z8oGGNJSNe87UVWh3FagJZSy_uhuoI';
    }

    canHandleURI(uri) {
        return [ this.url, 'https://www.mikoroku.com' ].includes(uri.origin);
    }

    async _getMangas() {
        const [ githubMangas, firestoreMangas, bloggerMangas, sdkMangas ] = await Promise.allSettled([
            this._getMangasFromGitHub(),
            this._getMangasFromFirestore(),
            this._getMangasFromBlogger(),
            this._getMangasFromSDK()
        ]);
        const mangaList = [];
        for(const result of [ githubMangas, firestoreMangas, bloggerMangas, sdkMangas ]) {
            if(result.status === 'fulfilled') {
                mangaList.push(...result.value);
            }
        }
        return mangaList.filter((manga, index) => {
            return index === mangaList.findIndex(entry => entry.id === manga.id);
        });
    }

    async _getMangasFromGitHub() {
        const list = await this._getGitHubList();
        return list
            .filter(item => item && item.title && item.slug && !this._isNovel(item.type))
            .map(item => ({
                id: this._createMangaID(item.slug),
                title: String(item.title).trim()
            }));
    }

    async _getGitHubList() {
        if(!this._githubListCache) {
            const request = new Request(new URL(this.githubList), this.requestOptions);
            this._githubListCache = this.fetchJSON(request).then(list => Array.isArray(list) ? list : []).catch(() => []);
        }
        return this._githubListCache;
    }

    _getGitHubEntry(list, slug, title) {
        return (list || []).find(item => item && (item.slug === slug || item.title === title));
    }

    /**
     * Firestore requests must carry the site as referrer, just like the
     * official website does when it calls the Firestore API from the browser.
     * Without it Google may reject the API key (HTTP referrer restriction).
     */
    _createFirestoreRequest(uri) {
        return new Request(uri, { ...this.requestOptions, referrer: this.url + '/' });
    }

    async _getMangasFromFirestore() {
        const mangaList = [];
        let pageToken = undefined;
        do {
            const uri = new URL(this.firestore);
            uri.searchParams.set('key', this.apiKey);
            uri.searchParams.set('pageSize', '300');
            uri.searchParams.append('mask.fieldPaths', 'title');
            uri.searchParams.append('mask.fieldPaths', 'type');
            uri.searchParams.append('mask.fieldPaths', 'isDraft');
            if(pageToken) {
                uri.searchParams.set('pageToken', pageToken);
            }

            const request = this._createFirestoreRequest(uri);
            const data = await this.fetchJSON(request);
            for(const document of data.documents || []) {
                const slug = this._getSlugFromDocumentName(document.name);
                const fields = this._decodeFirestoreFields(document.fields);
                if(!slug || fields.isDraft === true || this._isNovel(fields.type) || !fields.title) {
                    continue;
                }
                mangaList.push({
                    id: this._createMangaID(slug),
                    title: fields.title.trim()
                });
            }
            pageToken = data.nextPageToken;
        } while(pageToken);
        return mangaList;
    }

    /**
     * List the whole 'manga' collection through the website's own Firebase
     * SDK (same approach as the official site's fallbackFetch). This is the
     * most complete source: the REST endpoint above is throttled and the
     * Blogger series feed domain is dead, while the SDK runs on top of a
     * mikoroku.com page so the API key origin matches exactly like the site.
     */
    async _getMangasFromSDK() {
        try {
            const docs = await this._runFirebaseScript('mangas') || [];
            return docs
                .filter(doc => doc && doc.slug && doc.title && !this._isNovel(doc.type))
                .map(doc => ({
                    id: this._createMangaID(doc.slug),
                    title: String(doc.title).trim()
                }));
        } catch(error) {
            console.warn(`${this.label}: SDK manga list failed:`, error && error.message || error);
            return [];
        }
    }

    async _getMangasFromBlogger() {
        try {
            const uri = new URL('/feeds/posts/default', this.seriesFeed);
            uri.searchParams.set('alt', 'json');
            uri.searchParams.set('max-results', '500');
            const request = new Request(uri, this.requestOptions);
            const { feed } = await this.fetchJSON(request);
            return (feed.entry || [])
                .filter(entry => this._hasCategory(entry, [ 'Manga', 'Manhua', 'Manhwa' ]))
                .map(entry => {
                    const title = entry.title.$t.trim();
                    return {
                        id: this._createMangaID(this._slugify(title)),
                        title
                    };
                });
        } catch(error) {
            return [];
        }
    }

    async _getChapters(manga) {
        const slug = this._getMangaSlug(manga.id);
        try {
            const firestoreManga = await this._getFirestoreManga(slug);
            if(firestoreManga) {
                const chapters = await this._getChaptersFromFirestore(manga, slug, firestoreManga);
                if(chapters.length) {
                    return chapters;
                }
            }
        } catch(error) {
            console.warn(`${this.label}: Firestore chapters failed, falling back to Blogger:`, error && error.message || error);
        }
        // Fast Blogger lookup with the most likely titles first ...
        const quick = await this._getBloggerQueryCandidates(manga, slug, false);
        const quickChapters = await this._getBloggerChapters(manga, quick);
        if(quickChapters.length) {
            return quickChapters;
        }
        // ... then query Firestore through the website's own Firebase SDK.
        // The SDK uses the streaming Listen transport which, unlike the REST
        // endpoint above, is not throttled. It runs on top of a mikoroku.com
        // page so the API key origin matches exactly like the official site.
        try {
            const sdkChapters = await this._getChaptersFromSDK(manga, slug);
            if(sdkChapters.length) {
                return sdkChapters;
            }
        } catch(error) {
            console.warn(`${this.label}: SDK chapters failed:`, error && error.message || error);
        }
        // ... and finally try alternative spellings on the Blogger mirrors
        const extended = await this._getBloggerQueryCandidates(manga, slug, true);
        return this._getBloggerChapters(manga, extended.filter(title => quick.indexOf(title) === -1));
    }

    async _getChaptersFromFirestore(manga, slug, firestoreManga) {
        try {
            const subChapters = await this._getChaptersFromFirestoreSubcollection(slug);
            if(subChapters.length) {
                const chapters = this._mapFirestoreChapters(manga, slug, subChapters, firestoreManga.updatedAt || 0);
                if(chapters.length) {
                    return chapters;
                }
            }
        } catch(error) {
            // subcollection fetch failed (e.g. quota exceeded), fall back to embedded map
        }
        return this._mapFirestoreChapters(manga, slug, Object.entries(firestoreManga.chapters || {}).map(([ key, value ]) => ({ key, value })), firestoreManga.updatedAt || 0);
    }

    async _getChaptersFromFirestoreSubcollection(slug) {
        const chapters = [];
        let pageToken = undefined;
        do {
            const uri = new URL(`${this.firestore}/${encodeURIComponent(slug)}/chapters`);
            uri.searchParams.set('key', this.apiKey);
            uri.searchParams.set('pageSize', '300');
            if(pageToken) {
                uri.searchParams.set('pageToken', pageToken);
            }
            const request = this._createFirestoreRequest(uri);
            const data = await this.fetchJSON(request);
            for(const document of data.documents || []) {
                const key = this._getSlugFromDocumentName(document.name);
                const value = this._decodeFirestoreFields(document.fields);
                if(value && value.isDraft !== true) {
                    chapters.push({ key, value });
                }
            }
            pageToken = data.nextPageToken;
        } while(pageToken);
        return chapters;
    }

    _mapFirestoreChapters(manga, slug, entries, fallbackDate = 0) {
        const chapters = [];
        for(const { key, value } of entries) {
            // Never let a single malformed chapter document wipe out the whole list
            try {
                if(!value || typeof value !== 'object' || value.isDraft === true) {
                    continue;
                }
                const num = String(value.num || key || '').trim() || String(key);
                const title = String(value.title || `Chapter ${key}`).trim();
                const order = Number(value.order || parseFloat(key)) || 0;
                const date = value.updatedAt || value.createdAt || value.date || value.timestamp || fallbackDate || 0;
                const chapter = {
                    num,
                    title,
                    order,
                    date: typeof date === 'number' ? date : Date.parse(date) || fallbackDate || 0,
                    images: this._extractImages(value.images || value.content || value.html || ''),
                    thumbnail: typeof value.thumbnail === 'string' ? value.thumbnail : '',
                    slug,
                    docId: String(key),
                    source: 'firestore'
                };
                chapters.push({
                    id: JSON.stringify(chapter),
                    title: title.replace(String(manga.title), '').trim() || `Chapter ${num}`,
                    language: ''
                });
            } catch(error) {
                console.warn(`${this.label}: Skipping malformed chapter "${key}":`, error && error.message || error);
            }
        }
        // Chapters whose images are stored in a separate document are completed on demand in _getPages,
        // only drop entries that have neither images nor a document reference
        return chapters
            .filter(chapter => {
                const data = JSON.parse(chapter.id);
                return data.images.length || data.docId;
            })
            .sort((a, b) => JSON.parse(b.id).order - JSON.parse(a.id).order);
    }

    async _getBloggerChapters(manga, candidates) {
        const list = candidates || await this._getBloggerQueryCandidates(manga, this._getMangaSlug(manga.id), true);
        for(const query of list) {
            for(const base of [ this.chapterFeed, this.chapterFeed2 ]) {
                for(const fetcher of [ '_getBloggerChaptersByLabel', '_getBloggerChaptersByQuery' ]) {
                    try {
                        const data = await this[fetcher](query, base);
                        if(data.feed && data.feed.entry) {
                            const chapters = this._mapBloggerChapters(manga, data, list);
                            if(chapters.length) {
                                return chapters;
                            }
                        }
                    } catch(error) {
                        // try next query / feed / fetch mode
                    }
                }
            }
        }
        return [];
    }

    _firebaseConfig() {
        return {
            apiKey: this.apiKey,
            authDomain: 'mikoroku.firebaseapp.com',
            projectId: 'mikoroku'
        };
    }

    /**
     * Run a Firestore query through the official Firebase SDK inside a hidden
     * mikoroku.com window. The SDK talks to the streaming Listen transport
     * which is not throttled like the REST endpoint, and the page origin
     * matches the website so the API key is accepted exactly like there.
     * The injected driver only uses ES2018 syntax (HakuNeko runs Chromium 76).
     * Resolves with the operation result or null when anything goes wrong.
     */
    async _runFirebaseScript(operation, slug, docId) {
        const uri = new URL('/', this.url);
        const request = new Request(uri, this.requestOptions);
        const script = `
            new Promise(function(resolve) {
                var slug = ${JSON.stringify(slug)};
                var docId = ${JSON.stringify(docId || null)};
                var op = ${JSON.stringify(operation)};
                var config = ${JSON.stringify(this._firebaseConfig())};
                var settled = false;
                function done(value) {
                    if(!settled) {
                        settled = true;
                        resolve(value);
                    }
                }
                setTimeout(function() { done(null); }, 60000);
                function loadScript(src) {
                    return new Promise(function(res, rej) {
                        var s = document.createElement('script');
                        s.src = src;
                        s.onload = function() { res(); };
                        s.onerror = function() { rej(new Error('load ' + src)); };
                        document.head.appendChild(s);
                    });
                }
                function str(v) {
                    if(typeof v === 'string') return v;
                    if(v === undefined || v === null) return '';
                    try { return String(v); } catch(e) { return ''; }
                }
                var httpRe = new RegExp('^https?://', 'i');
                function strList(v) {
                    var arr = Array.isArray(v) ? v : ((v && typeof v === 'object') ? Object.keys(v).map(function(k) { return v[k]; }) : [v]);
                    var out = [];
                    arr.forEach(function(x) {
                        if(typeof x === 'string' && httpRe.test(x.trim())) out.push(x.trim());
                    });
                    return out.filter(function(u, i, a) { return a.indexOf(u) === i; });
                }
                function num(v, fallback) {
                    var n = Number(v);
                    return (typeof n === 'number' && isFinite(n)) ? n : fallback;
                }
                function ts(v) {
                    try {
                        if(v && typeof v.toDate === 'function') return v.toDate().getTime();
                        if(typeof v === 'number') return v;
                        if(typeof v === 'string') {
                            var t = Date.parse(v);
                            return isNaN(t) ? 0 : t;
                        }
                    } catch(e) { /* fall through */ }
                    return 0;
                }
                function safeDoc(id, d) {
                    d = d || {};
                    return {
                        key: str(id),
                        num: str(d.num || d.label || id),
                        title: str(d.title || d.label || ('Chapter ' + id)),
                        order: num(d.order, parseFloat(id) || 0),
                        date: ts(d.updatedAt || d.createdAt || d.date || d.timestamp),
                        images: strList(d.images || d.pages || d.content || d.html),
                        thumbnail: str(d.thumbnail || d.cover || '')
                    };
                }
                function getDb() {
                    var app = null;
                    try {
                        firebase.apps.forEach(function(a) {
                            if(a && a.options && a.options.projectId === config.projectId) app = a;
                        });
                    } catch(e) { /* ignore */ }
                    if(!app) {
                        try { app = firebase.app('mikoroku-hakuneko'); }
                        catch(e) { app = firebase.initializeApp(config, 'mikoroku-hakuneko'); }
                    }
                    return app.firestore();
                }
                function listMangas(db) {
                    return db.collection('manga').get().then(function(snap) {
                        var list = [];
                        snap.forEach(function(doc) {
                            try {
                                var d = doc.data() || {};
                                if(d.isDraft === true) return;
                                var title = str(d.title);
                                if(!title) return;
                                list.push({ slug: str(doc.id), title: title, type: str(d.type) });
                            } catch(e) { /* skip malformed doc */ }
                        });
                        return list;
                    });
                }
                function listChapters(db) {
                    return db.collection('manga').doc(slug).collection('chapters').get().then(function(snap) {
                        var list = [];
                        snap.forEach(function(doc) {
                            try { list.push(safeDoc(doc.id, doc.data())); } catch(e) { /* skip malformed doc */ }
                        });
                        if(list.length) return list;
                        return db.collection('manga').doc(slug).get().then(function(parent) {
                            if(!parent.exists) return [];
                            var map = parent.data().chapters || {};
                            return Object.keys(map).map(function(key) { return safeDoc(key, map[key]); });
                        });
                    });
                }
                function chapterImages(db) {
                    return db.collection('manga').doc(slug).collection('chapters').doc(docId).get().then(function(snap) {
                        if(snap.exists) {
                            var imgs = strList((snap.data() || {}).images || (snap.data() || {}).pages || '');
                            if(imgs.length) return imgs;
                        }
                        return db.collection('manga').doc(slug).get().then(function(parent) {
                            if(!parent.exists) return [];
                            var entry = (parent.data().chapters || {})[docId] || {};
                            return strList(entry.images || entry.pages || entry.content || entry.html || '');
                        });
                    });
                }
                loadScript('https://www.gstatic.com/firebasejs/10.14.0/firebase-app-compat.js')
                    .then(function() { return loadScript('https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore-compat.js'); })
                    .then(function() {
                        var db = getDb();
                        if(op === 'pages') return chapterImages(db);
                        if(op === 'mangas') return listMangas(db);
                        return listChapters(db);
                    })
                    .then(function(result) { done(result); })
                    .catch(function() { done(null); });
            });
        `;
        return await Engine.Request.fetchUI(request, script, 90000);
    }

    async _getChaptersFromSDK(manga, slug) {
        const entries = await this._runFirebaseScript('chapters', slug) || [];
        return entries
            .filter(entry => entry && (entry.num || entry.title))
            .map(entry => {
                const num = String(entry.num || '').trim();
                const title = String(entry.title || '').trim() || `Chapter ${num}`;
                const chapter = {
                    num: num || title,
                    title: title,
                    order: Number(entry.order) || parseFloat(num) || 0,
                    date: Number(entry.date) || 0,
                    images: Array.isArray(entry.images) ? entry.images : [],
                    thumbnail: entry.thumbnail || '',
                    slug: slug,
                    docId: entry.key || num,
                    source: 'firestore'
                };
                return {
                    id: JSON.stringify(chapter),
                    title: title.replace(String(manga.title), '').trim() || `Chapter ${chapter.num}`,
                    language: ''
                };
            })
            .sort((a, b) => JSON.parse(b.id).order - JSON.parse(a.id).order);
    }

    async _getChapterImagesFromSDK(slug, docId) {
        try {
            const images = await this._runFirebaseScript('pages', slug, docId) || [];
            return (Array.isArray(images) ? images : []).filter(url => typeof url === 'string' && /^https?:\/\//i.test(url));
        } catch(error) {
            return [];
        }
    }

    async _getBloggerQueryCandidates(manga, slug, extended) {
        const candidates = [];
        const push = title => {
            title = String(title || '').trim();
            if(title.length >= 3 && !candidates.includes(title)) {
                candidates.push(title);
            }
        };
        push(manga.title);
        try {
            const entry = this._getGitHubEntry(await this._getGitHubList(), slug, manga.title);
            if(entry) {
                push(entry.title);
                if(extended) {
                    for(const alt of String(entry.altTitle || '').split(';')) {
                        push(alt);
                    }
                }
            }
        } catch(error) {
            // ignore, fall back to title only
        }
        if(extended) {
            // shortened variants (text before subtitle separators) for Blogger search tokenization
            for(const title of [ ...candidates ]) {
                push(title.split(/\s*[~:|]\s*/)[0]);
                push(title.split(/\s+\(\s*/)[0]);
            }
        }
        return candidates;
    }

    _mapBloggerChapters(manga, data, candidates = [ manga.title ]) {
        const queries = candidates.map(title => this._normalizeTitle(title)).filter(Boolean);
        return (data.feed.entry || [])
            .filter(entry => {
                // Blogger `q` may return loosely related posts for short queries,
                // keep only entries that actually belong to this series
                const haystacks = [ entry.title && entry.title.$t || '', ...(entry.category || []).map(category => category.term || '') ];
                return haystacks.some(text => queries.some(query => this._normalizeTitle(text).includes(query)));
            })
            .map(entry => {
                const title = entry.title.$t.trim();
                const images = this._extractImages(entry.content && entry.content.$t || '');
                const link = entry.link.find(link => link.rel === 'alternate');
                const published = Date.parse(entry.published && entry.published.$t || entry.updated && entry.updated.$t || '') || 0;
                const number = this._getChapterNumber(title);
                const chapter = {
                    num: number || title,
                    title: title.replace(manga.title, '').trim() || title,
                    order: number || 0,
                    date: published,
                    images,
                    url: link && link.href,
                    slug: this._getMangaSlug(manga.id),
                    source: 'blogger'
                };
                return {
                    id: JSON.stringify(chapter),
                    title: chapter.title,
                    language: ''
                };
            })
            .filter(chapter => {
                const data = JSON.parse(chapter.id);
                return data.url && data.images.length;
            })
            .sort((a, b) => {
                const chapterA = JSON.parse(a.id);
                const chapterB = JSON.parse(b.id);
                return chapterB.order - chapterA.order || chapterB.date - chapterA.date;
            });
    }

    async _getBloggerChaptersByLabel(title, base = this.chapterFeed) {
        const uri = new URL(`/feeds/posts/default/-/${encodeURIComponent(title)}`, base);
        uri.searchParams.set('alt', 'json');
        uri.searchParams.set('max-results', '500');
        const request = new Request(uri, this.requestOptions);
        return this.fetchJSON(request);
    }

    async _getBloggerChaptersByQuery(title, base = this.chapterFeed) {
        const uri = new URL('/feeds/posts/default', base);
        uri.searchParams.set('alt', 'json');
        uri.searchParams.set('max-results', '500');
        uri.searchParams.set('q', title);
        const request = new Request(uri, this.requestOptions);
        return this.fetchJSON(request);
    }

    async _getPages(chapter) {
        const data = JSON.parse(chapter.id);
        if(data.images && data.images.length) {
            return data.images.map(url => this._getFullImage(url));
        }
        // Chapter images stored in a separate Firestore document (same approach as the website)
        if(data.slug && data.docId) {
            const images = await this._getSingleChapterImages(data.slug, data.docId);
            if(images.length) {
                return images.map(url => this._getFullImage(url));
            }
        }
        // Last resort: query Firestore through the website's own Firebase SDK (not throttled)
        if(data.slug && data.num !== undefined) {
            try {
                const images = await this._getChapterImagesFromSDK(data.slug, data.docId || String(data.num));
                if(images.length) {
                    return images.map(url => this._getFullImage(url));
                }
            } catch(error) {
                console.warn(`${this.label}: SDK pages failed:`, error && error.message || error);
            }
        }
        return (data.images || []).map(url => this._getFullImage(url));
    }

    async _getSingleChapterImages(slug, docId) {
        try {
            const uri = new URL(`${this.firestore}/${encodeURIComponent(slug)}/chapters/${encodeURIComponent(docId)}`);
            uri.searchParams.set('key', this.apiKey);
            const request = this._createFirestoreRequest(uri);
            const document = await this.fetchJSON(request);
            const value = this._decodeFirestoreFields(document.fields);
            return this._extractImages(value.images || value.content || value.html || '');
        } catch(error) {
            return [];
        }
    }

    async _getMangaFromURI(uri) {
        const slug = this._getSlugFromURI(uri);
        const githubManga = await this._getGitHubManga(slug);
        if(githubManga) {
            return new Manga(this, this._createMangaID(slug), githubManga.title);
        }

        try {
            const firestoreManga = await this._getFirestoreManga(slug);
            if(firestoreManga && firestoreManga.title) {
                return new Manga(this, this._createMangaID(slug), firestoreManga.title);
            }
        } catch(error) {
            // Firestore quota may be exceeded, fall through to Blogger feeds
        }

        const bloggerManga = await this._getBloggerManga(slug);
        if(bloggerManga) {
            return new Manga(this, this._createMangaID(slug), bloggerManga.title);
        }

        const title = slug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        return new Manga(this, this._createMangaID(slug), title);
    }

    async _getGitHubManga(slug) {
        if(!slug) {
            return undefined;
        }
        try {
            const entry = this._getGitHubEntry(await this._getGitHubList(), slug);
            return entry ? { title: String(entry.title).trim() } : undefined;
        } catch(error) {
            return undefined;
        }
    }

    async _getFirestoreManga(slug) {
        if(!slug) {
            return undefined;
        }
        const uri = new URL(`${this.firestore}/${encodeURIComponent(slug)}`);
        uri.searchParams.set('key', this.apiKey);
        const request = this._createFirestoreRequest(uri);
        try {
            const document = await this.fetchJSON(request);
            return this._decodeFirestoreFields(document.fields);
        } catch(error) {
            if(!/status: 404|NOT_FOUND/i.test(error.message)) {
                console.warn(error);
            }
            return undefined;
        }
    }

    async _getBloggerManga(slug) {
        if(!slug) {
            return undefined;
        }
        try {
            const uri = new URL('/feeds/posts/default', this.seriesFeed);
            uri.searchParams.set('alt', 'json');
            uri.searchParams.set('max-results', '500');
            const request = new Request(uri, this.requestOptions);
            const { feed } = await this.fetchJSON(request);
            const entry = (feed.entry || []).find(entry => this._slugify(entry.title.$t) === slug);
            return entry ? { title: entry.title.$t.trim() } : undefined;
        } catch(error) {
            return undefined;
        }
    }

    _decodeFirestoreFields(fields = {}) {
        return Object.entries(fields).reduce((object, [ key, value ]) => {
            object[key] = this._decodeFirestoreValue(value);
            return object;
        }, {});
    }

    _decodeFirestoreValue(value) {
        if(value.stringValue !== undefined) {
            return value.stringValue;
        }
        if(value.integerValue !== undefined) {
            return Number(value.integerValue);
        }
        if(value.doubleValue !== undefined) {
            return value.doubleValue;
        }
        if(value.booleanValue !== undefined) {
            return value.booleanValue;
        }
        if(value.timestampValue !== undefined) {
            return Date.parse(value.timestampValue);
        }
        if(value.arrayValue !== undefined) {
            return (value.arrayValue.values || []).map(item => this._decodeFirestoreValue(item));
        }
        if(value.mapValue !== undefined) {
            return this._decodeFirestoreFields(value.mapValue.fields);
        }
        return undefined;
    }

    _extractImages(input) {
        if(!input) {
            return [];
        }
        if(Array.isArray(input)) {
            return input
                .flatMap(item => this._extractImages(item))
                .filter((url, index, images) => url && images.indexOf(url) === index);
        }
        if(typeof input === 'object') {
            // Firestore maps (e.g. images stored as { 0: url, 1: url } or { url }) are decoded to plain objects
            return this._extractImages(Object.values(input));
        }
        if(typeof input !== 'string') {
            return [];
        }
        if(/^https?:\/\//i.test(input)) {
            return [ input ];
        }
        const matches = [
            ...input.matchAll(/<img[^>]+src=["']([^"']+)["']/gi),
            ...input.matchAll(/<img[^>]+data-src=["']([^"']+)["']/gi)
        ];
        return matches.map(match => match[1])
            .filter((url, index, images) => /^https?:\/\//i.test(url) && images.indexOf(url) === index);
    }

    _getFullImage(url) {
        if(/blogger\.googleusercontent\.com/i.test(url)) {
            return url.replace(/\/s\d+(?:-[a-z0-9]+)?\//i, '/s0/');
        }
        return url;
    }

    _getChapterNumber(title) {
        const match = title.match(/chapter\s*([0-9]+(?:\.[0-9]+)?)/i) || title.match(/([0-9]+(?:\.[0-9]+)?)/);
        return match ? parseFloat(match[1]) : 0;
    }

    _hasCategory(entry, categories) {
        return (entry.category || []).some(category => categories.includes(category.term));
    }

    _isNovel(type = '') {
        return /novel/i.test(type);
    }

    _createMangaID(slug) {
        return `/detail?slug=${encodeURIComponent(slug)}`;
    }

    _getMangaSlug(id) {
        return this._getSlugFromURI(new URL(id, this.url));
    }

    _getSlugFromURI(uri) {
        let slug = uri.searchParams.get('slug');
        if(!slug) {
            const path = uri.pathname.split('/').filter(Boolean);
            slug = path[0] === 'detail' || path[0] === 'reader' ? path[1] : path.pop();
        }
        return (slug || '').replace(/-chapter-.*/i, '');
    }

    _getSlugFromDocumentName(name = '') {
        return name.split('/').pop();
    }

    _normalizeTitle(title) {
        return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }

    _slugify(title) {
        return title.toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-');
    }
}
