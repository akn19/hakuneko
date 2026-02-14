import Connector from '../engine/Connector.mjs';
import Manga from '../engine/Manga.mjs';

export default class ShinigamiID extends Connector {

    constructor() {
        super();
        super.id = 'shinigamiid';
        super.label = 'Shinigami ID';
        this.tags = ['manga', 'manhua', 'manhwa', 'indonesian', 'scanlation'];
        this.url = 'https://09.shinigami.asia';
        this.apiUrl = 'https://api.shngm.io/v1/';
        this.config = {
            url: {
                label: 'URL',
                description: 'This website changes their URL regularly.\nThis is the last known URL which can also be manually set by the user.',
                input: 'text',
                value: 'https://09.shinigami.asia'
            }
        };
    }

    get url() {
        return this.config.url.value;
    }

    set url(value) {
        if (this.config && value) {
            this.config.url.value = value;
            Engine.Settings.save();
        }
    }

    canHandleURI(uri) {
        return /https?:\/\/\d+\.shinigami\.asia/.test(uri.origin);
    }

    async _initializeConnector() {
        let uri = new URL(this.url);
        let request = new Request(uri.href, this.requestOptions);
        this.url = await Engine.Request.fetchUI(request, 'window.location.origin');
        console.log(`Assigned URL '${this.url}' to ${this.label}`);
    }

    async _getMangaFromURI(uri) {
        const slug = uri.pathname.split('/').pop();
        const request = new Request(new URL(`./manga/detail/${slug}`, this.apiUrl), this.requestOptions);
        const { data } = await this.fetchJSON(request);
        return new Manga(this, data.manga_id, data.title.trim());
    }

    async _getMangas() {
        const request = new Request(new URL('./manga/list?page=1&page_size=9999', this.apiUrl), this.requestOptions);
        const { data } = await this.fetchJSON(request);
        return data.map(manga => ({
            id: manga.manga_id,
            title: manga.title.trim()
        }));
    }

    async _getChapters(manga) {
        const request = new Request(new URL(`./chapter/${manga.id}/list?page=1&page_size=9999`, this.apiUrl), this.requestOptions);
        const { data } = await this.fetchJSON(request);
        return data.map(chapter => ({
            id: chapter.chapter_id,
            title: ['Chapter', chapter.chapter_number, chapter.chapter_title].join(' ').trim()
        }));
    }

    async _getPages(chapter) {
        const request = new Request(new URL(`./chapter/detail/${chapter.id}`, this.apiUrl), this.requestOptions);
        const { data } = await this.fetchJSON(request);
        return data.chapter.data.map(image => new URL(`${data.chapter.path}${image}`, data.base_url).href);
    }
}
