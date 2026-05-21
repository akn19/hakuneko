import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

export default class Mikoroku extends Connector {
    constructor() {
        super();
        super.id = 'mikoroku';
        super.label = 'Mikoroku';
        this.tags = [ 'manga', 'scanlation', 'indonesian' ];
        this.url = 'https://mikoroku.com';
        this.seriesFeed = 'https://www.mikoroku.top';
        this.chapterFeed = 'https://www.mikodrive.my.id';
        this.firestore = 'https://firestore.googleapis.com/v1/projects/mikoroku/databases/(default)/documents/manga';
        this.apiKey = 'AIzaSyAi8z8oGGNJSNe87UVWh3FagJZSy_uhuoI';
    }

    canHandleURI(uri) {
        return [ this.url, 'https://www.mikoroku.com' ].includes(uri.origin);
    }

    async _getMangas() {
        const [ firestoreMangas, bloggerMangas ] = await Promise.allSettled([
            this._getMangasFromFirestore(),
            this._getMangasFromBlogger()
        ]);
        const mangaList = [];
        for(const result of [ firestoreMangas, bloggerMangas ]) {
            if(result.status === 'fulfilled') {
                mangaList.push(...result.value);
            }
        }
        return mangaList.filter((manga, index) => {
            return index === mangaList.findIndex(entry => entry.id === manga.id);
        });
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

            const request = new Request(uri, this.requestOptions);
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

    async _getMangasFromBlogger() {
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
    }

    async _getChapters(manga) {
        const slug = this._getMangaSlug(manga.id);
        const firestoreManga = await this._getFirestoreManga(slug);
        if(firestoreManga) {
            const chapters = this._getChaptersFromFirestore(manga, firestoreManga);
            if(chapters.length) {
                return chapters;
            }
        }
        return this._getChaptersFromBlogger(manga);
    }

    _getChaptersFromFirestore(manga, firestoreManga) {
        return Object.entries(firestoreManga.chapters || {})
            .map(([ key, value ]) => {
                const chapter = {
                    num: value.num || key,
                    title: value.title || `Chapter ${key}`,
                    order: value.order || parseFloat(key) || 0,
                    date: value.updatedAt || value.createdAt || value.date || value.timestamp || firestoreManga.updatedAt || 0,
                    images: this._extractImages(value.images || value.content || value.html || ''),
                    thumbnail: value.thumbnail || '',
                    source: 'firestore'
                };
                return {
                    id: JSON.stringify(chapter),
                    title: chapter.title.replace(manga.title, '').trim() || `Chapter ${chapter.num}`,
                    language: ''
                };
            })
            .filter(chapter => JSON.parse(chapter.id).images.length)
            .sort((a, b) => JSON.parse(b.id).order - JSON.parse(a.id).order);
    }

    async _getChaptersFromBlogger(manga) {
        let data;
        try {
            data = await this._getBloggerChaptersByLabel(manga.title);
        } catch(error) {
            data = {};
        }
        if(!data.feed || !data.feed.entry) {
            data = await this._getBloggerChaptersByQuery(manga.title);
        }

        return (data.feed.entry || [])
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

    async _getBloggerChaptersByLabel(title) {
        const uri = new URL(`/feeds/posts/default/-/${encodeURIComponent(title)}`, this.chapterFeed);
        uri.searchParams.set('alt', 'json');
        uri.searchParams.set('max-results', '500');
        const request = new Request(uri, this.requestOptions);
        return this.fetchJSON(request);
    }

    async _getBloggerChaptersByQuery(title) {
        const uri = new URL('/feeds/posts/default', this.chapterFeed);
        uri.searchParams.set('alt', 'json');
        uri.searchParams.set('max-results', '500');
        uri.searchParams.set('q', title);
        const request = new Request(uri, this.requestOptions);
        return this.fetchJSON(request);
    }

    async _getPages(chapter) {
        const data = JSON.parse(chapter.id);
        return data.images.map(url => this._getFullImage(url));
    }

    async _getMangaFromURI(uri) {
        const slug = this._getSlugFromURI(uri);
        const firestoreManga = await this._getFirestoreManga(slug);
        if(firestoreManga) {
            return new Manga(this, this._createMangaID(slug), firestoreManga.title);
        }

        const bloggerManga = await this._getBloggerManga(slug);
        if(bloggerManga) {
            return new Manga(this, this._createMangaID(slug), bloggerManga.title);
        }

        const title = slug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
        return new Manga(this, this._createMangaID(slug), title);
    }

    async _getFirestoreManga(slug) {
        if(!slug) {
            return undefined;
        }
        const uri = new URL(`${this.firestore}/${encodeURIComponent(slug)}`);
        uri.searchParams.set('key', this.apiKey);
        const request = new Request(uri, this.requestOptions);
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
        const uri = new URL('/feeds/posts/default', this.seriesFeed);
        uri.searchParams.set('alt', 'json');
        uri.searchParams.set('max-results', '500');
        const request = new Request(uri, this.requestOptions);
        const { feed } = await this.fetchJSON(request);
        const entry = (feed.entry || []).find(entry => this._slugify(entry.title.$t) === slug);
        return entry ? { title: entry.title.$t.trim() } : undefined;
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

    _slugify(title) {
        return title.toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .trim()
            .replace(/\s+/g, '-');
    }
}
