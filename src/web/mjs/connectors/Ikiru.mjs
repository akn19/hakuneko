import Connector from "../engine/Connector.mjs";
import Manga from "../engine/Manga.mjs";

export default class Ikiru extends Connector {

    constructor() {
        super();
        super.id    = "ikiru";
        super.label = "Ikiru";
        this.tags   = ["manga", "manhwa", "manhua", "indonesian"];
        this.url    = "https://04.ikiru.wtf";
    }

    async _getMangas() {
        const mangaList = [];
        for (let page = 1; ; page++) {
            const url = new URL(`/project/?the_page=${page}`, this.url);
            const dom = await this.fetchDOM(new Request(url), "div#search-results a:not([class])");
            if (!dom || !dom.length) break;
            for (const anchor of dom) {
                const title = (anchor.innerText || anchor.textContent || "")
                    .replace(/\s+Bahasa\s+Indonesia/gi, "")
                    .replace(/\s*-\s*Ikiru/gi, "")
                    .trim();
                mangaList.push({ id: anchor.pathname, title });
            }
        }
        return mangaList;
    }

    async _getChapters(manga) {
        const mangaURL    = new URL(manga.id, this.url);
        const chapterDivs = await this.fetchDOM(new Request(mangaURL), "div#chapter-list");
        if (!chapterDivs || !chapterDivs.length) {
            throw new Error(`div#chapter-list not found: ${mangaURL}`);
        }

        const hxGet = (chapterDivs[0].getAttribute("hx-get") || "").trim();
        if (!hxGet) {
            throw new Error(`hx-get missing on div#chapter-list for: ${manga.id}`);
        }

        const anchors = await this.fetchDOM(new Request(new URL(hxGet)), "div[data-chapter-number] a");
        if (!anchors || !anchors.length) return [];

        return anchors.map(anchor => {
            const span  = anchor.querySelector("span");
            const title = (span ? span.textContent : anchor.textContent || "").trim();
            return { id: anchor.pathname, title };
        });
    }

    async _getPages(chapter) {
        const url      = new URL(chapter.id, this.url);
        const response = await fetch(url.href);
        const html     = await response.text();

        // Ambil section[data-image-data] lalu extract semua src dari img di dalamnya
        // Regex menangani single quote maupun double quote
        const sectionMatch = html.match(/data-image-data[^>]*>([\s\S]*?)<\/section>/);
        if (!sectionMatch) return [];

        const sectionHTML = sectionMatch[1];
        const pages = [];
        const imgRegex = /<img[^>]+src=['"]([^'"]+)['"]/gi;
        let match;
        while ((match = imgRegex.exec(sectionHTML)) !== null) {
            if (match[1].startsWith("http")) {
                pages.push(match[1]);
            }
        }
        return pages;
    }

    async _getMangaFromURI(uri) {
        const dom   = await this.fetchDOM(new Request(uri), "title");
        const raw   = dom && dom[0] ? (dom[0].innerText || dom[0].textContent || "") : "";
        const title = raw
            .replace(/\s+Bahasa\s+Indonesia/gi, "")
            .replace(/\s*-\s*Ikiru/gi, "")
            .trim();
        return new Manga(this, uri.pathname, title || uri.pathname.split("/").filter(Boolean).pop());
    }
}
