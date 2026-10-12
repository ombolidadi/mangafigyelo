# Mangafigyelő

Manga- és képregényolvasó webapp, elsősorban iPadre: megadod egy sorozat oldalának címét, az
alkalmazás minden megnyitáskor megnézi, jött-e új fejezet, jelzi, és a fejezetet közvetlenül
benne olvashatod.

**Megnyitás:** <https://ombolidadi.github.io/mangafigyelo/>

iPaden: Safari → Megosztás → **Főképernyőhöz adás**.

## Egyszeri beállítás: a háttérszolgáltatás

Egy böngészőben futó oldal nem tölthet le közvetlenül más webhelyeket, ezért a fejezetlistát és
a képeket egy kis közvetítő kéri le. A GitHub Pages csak az alkalmazást tudja kiszolgálni, a
közvetítőt nem – azt egy ingyenes Cloudflare Workerként lehet futtatni:

1. Cloudflare-fiók → *Workers & Pages → Create → Worker* (Hello World sablon) → Deploy.
2. *Edit code*: a szerkesztő tartalmát cseréld le a [`worker.js`](worker.js) tartalmára → Deploy.
3. Ajánlott: *Settings → Variables and Secrets* alatt vegyél fel egy `ACCESS_KEY` nevű titkot,
   hogy más ne használhassa a közvetítődet.
4. Az alkalmazásban: ⚙ Beállítások → „Háttérszolgáltatás címe” = a Worker címe
   (`https://….workers.dev`), „Hozzáférési kulcs” = az előbbi titok.

## Használat

- **＋ Hozzáadás:** a sorozat fő oldalának címe (ahol a fejezetek listája van). MangaDex-címek
  (`mangadex.org/title/…`) és RSS-hírcsatornák is megadhatók.
- **Figyelés:** megnyitáskor, illetve visszatéréskor (10 percnél régebbi ellenőrzés után) fut le;
  kézzel a ↻ Frissítés gombbal. Bezárt alkalmazásnál nincs háttérellenőrzés.
- **Olvasó:** görgetős vagy lapozós mód, jobbról balra lapozás; a képernyő közepére koppintva
  jelennek meg a vezérlők. A fejezet végére érve olvasottnak jelöli, és megjegyzi, hol tartasz.
- A könyvtár az eszköz böngészőjében tárolódik; a Beállításokban fájlba menthető és visszatölthető.

## Korlátok

- Az automatikus felismerés a szokásos felépítésű oldalakon működik (a linkekben „chapter”,
  „fejezet”, „episode” stb. és sorszám). Ha nem talál fejezetet vagy rossz képeket mutat, a
  Haladó beállításokban megadható a fejezetlinkek és a képek CSS-szelektora.
- Nem működik olyan oldalakkal, amelyek csak JavaScripttel töltik be a tartalmat, bejelentkezést
  kérnek, vagy robotvédelemmel tiltják a gépi letöltést. Ilyenkor az olvasó felkínálja az eredeti
  oldal megnyitását.
- Csak olyan forrást adj meg, amelynek a tartalmát jogosult vagy így olvasni.

## Fejlesztés, helyi futtatás

| Fájl | Szerepe |
|---|---|
| `docs/` | Maga az alkalmazás – ezt szolgálja ki a GitHub Pages |
| `worker.js`, `wrangler.toml` | A közvetítő Cloudflare Workerként |
| `server.py` | Helyi kiszolgáló + közvetítő, csak Python 3 kell hozzá |

```bash
python3 server.py
```

Utána: <http://localhost:8787> – itt a közvetítő is helyben fut, nem kell semmit beállítani.
