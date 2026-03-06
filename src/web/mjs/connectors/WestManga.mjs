import Connector from "../engine/Connector.mjs";
import Manga from "../engine/Manga.mjs";

export default class WestManga extends Connector {
    constructor() {
        super();
        super.id = "westmanga";
        super.label = "WestManga";
        this.tags = ["manga", "manhua", "manhwa", "indonesian"];
        this.url = "https://westmanga.tv";

        this.api = {
            url: "https://data.westmanga.tv/api/",
            nonce: "wm-api-request",
            accessKey: "WM_WEB_FRONT_END",
            secretKey: "xxxoidj",
        };
    }

    async _getMangas() {
        const mangaList = [];
        for (let page = 1; ; page++) {
            const { data, paginator } = await this.fetchAPI(`contents?page=${page}&per_page=20&type=Comic`);
            if (!data || !data.length) break;
            mangaList.push(
                ...data.map(({ slug, title }) => ({
                    id: slug,
                    title: title.replace(/bahasa indonesia/i, "").trim(),
                }))
            );
            if (!paginator || paginator.current_page >= paginator.last_page) break;
        }
        return mangaList;
    }

    async _getChapters(manga) {
        const { data: { chapters }} = await this.fetchAPI(`comic/${manga.id}`);
        return chapters.map(({ slug, number }) => {
            let title = number.toString().trim();
            if (!/^chapter\s+/i.test(title)) {
                title = `Chapter ${title}`;
            }
            return {
                id: slug,
                title: title,
            };
        });
    }

    async _getPages(chapter) {
        const { data: { images }} = await this.fetchAPI(`v/${chapter.id}`);
        return images;
    }

    async _getMangaFromURI(uri) {
        const slug = uri.pathname.split("/").filter(Boolean).pop();
        const {data: { title }} = await this.fetchAPI(`comic/${slug}`);
        return new Manga(this, slug, title.replace(/bahasa indonesia/i, "").trim());
    }

    async fetchAPI(endpoint) {
        const url = new URL(endpoint, this.api.url);
        const timestamp = `${Date.now()}`.slice(0, -3);
        const signature = await this.generateHMAC256(
            this.api.nonce,
            timestamp,
            "GET",
            url.pathname,
            this.api.accessKey,
            this.api.secretKey
        );

        const request = new Request(url, {
            ...this.requestOptions,
            headers: {
                ...this.requestOptions.headers,
                Referer: this.url,
                "X-Wm-Request-Time": timestamp,
                "X-Wm-Accses-Key": this.api.accessKey,
                "X-Wm-Request-Signature": signature,
            },
        });

        return this.fetchJSON(request);
    }

    async generateHMAC256(data, ...keyData) {
        const key = keyData.join("");
        const hash = CryptoJS.HmacSHA256(data, key);
        return CryptoJS.enc.Hex.stringify(hash);
    }
}
