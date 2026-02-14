import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

// Shared semaphore across all instances to prevent "too many open files" error
const sharedSemaphore = {
    maxConcurrentRequests: 2, // Global limit for all instances
    activeRequests: 0,
    requestQueue: [],
    requestDelay: 300 // ms
};

export default class LunarAnimes extends Connector {

    constructor() {
        super();
        super.id = 'lunaranimes';
        super.label = 'Lunar Animes';
        this.tags = ['manga', 'manhwa', 'manhua', 'multi-lingual', 'aggregator'];
        this.url = 'https://lunaranime.ru';
        this.apiUrl = 'https://api.lunaranime.ru/api/manga/';

        this.languageMap = {
            'zh': 'Chinese',
            'en': 'English',
            'id': 'Indonesian',
            'ja': 'Japanese',
            'ko': 'Korean',
            'pl': 'Polish',
            'pt': 'Portuguese',
            'ru': 'Russian',
            'es': 'Spanish',
            'th': 'Thai',
            'tr': 'Turkish',
            'vi': 'Vietnamese',
        };
    }

    async _wait() {
        return new Promise(resolve => setTimeout(resolve, sharedSemaphore.requestDelay));
    }

    async _acquireRequestSlot() {
        while (sharedSemaphore.activeRequests >= sharedSemaphore.maxConcurrentRequests) {
            await new Promise(resolve => sharedSemaphore.requestQueue.push(resolve));
        }
        sharedSemaphore.activeRequests++;
    }

    _releaseRequestSlot() {
        sharedSemaphore.activeRequests--;
        const next = sharedSemaphore.requestQueue.shift();
        if (next) {
            next();
        }
    }

    async _throttledFetch(requestFunc) {
        await this._acquireRequestSlot();
        try {
            await this._wait();
            return await requestFunc();
        } finally {
            this._releaseRequestSlot();
        }
    }

    canHandleURI(uri) {
        return /https?:\/\/lunaranime\.ru\/manga\/[^/]+/.test(uri.href);
    }

    async _getMangaFromURI(uri) {
        const slug = uri.pathname.split('/').pop();
        return await this._throttledFetch(async () => {
            const request = new Request(new URL(this.url + uri.pathname), this.requestOptions);
            const data = await this.fetchDOM(request, 'meta[property="og:title"]');
            const title = data[0].content.trim();
            return new Manga(this, slug, title);
        });
    }

    async _getMangas() {
        return await this._throttledFetch(async () => {
            const request = new Request(new URL('search?', this.apiUrl), this.requestOptions);
            const { manga } = await this.fetchJSON(request);
            return manga.map(entry => ({
                id: entry.slug,
                title: entry.title,
            }));
        });
    }

    async _getChapters(manga) {
        return await this._throttledFetch(async () => {
            const request = new Request(new URL(manga.id, this.apiUrl), this.requestOptions);
            const { data } = await this.fetchJSON(request);
            return data.map(chapter => ({
                id: `${manga.id}/${chapter.chapter_number}?language=${chapter.language}`,
                title: `Chapter ${chapter.chapter_number} (${chapter.language})`,
                language: chapter.language,
            }));
        });
    }

    async _getPages(chapter) {
        return await this._throttledFetch(async () => {
            const request = new Request(new URL(chapter.id, this.apiUrl), this.requestOptions);
            const { data: { images } } = await this.fetchJSON(request);
            return images.map(url => this.createConnectorURI(url));
        });
    }

    async _handleConnectorURI(payload) {
        return await this._throttledFetch(async () => {
            const request = new Request(payload, this.requestOptions);
            const response = await fetch(request);
            const data = await response.blob();
            return this._blobToBuffer(data);
        });
    }
}
