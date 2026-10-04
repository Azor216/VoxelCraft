# Voxel Frontier

Voxelová survival hra fungující jako samostatný `index.html`. Singleplayer a ruční WebRTC připojení fungují přímo z disku i na GitHub Pages.

## Automatický LAN multiplayer

1. Na počítači hostitele nainstaluj [Node.js 20+](https://nodejs.org/).
2. V kořeni projektu spusť `npm install`.
3. Spusť `npm start`.
4. Hostitel i ostatní hráči otevřou LAN adresu vypsanou v terminálu, například `http://192.168.1.20:8080`.
5. Hostitel vybere svět a klikne na **Hostovat LAN**. Ostatní ho najdou přes **Obnovit lobby**.

Server podporuje až 8 hráčů v jedné místnosti. Hostitel sdílí seed a úpravy bloků, zatímco inventář, zdraví a hlad zůstávají každému hráči vlastní.

### Přechod z GitHub Pages

Na GitHub Pages klikni na **Otevřít LAN verzi**. Hostitel zadá `localhost:8080`, ostatní hráči zadají LAN adresu vypsanou hostitelovým serverem, například `192.168.1.20:8080`. Prohlížeč otevře stejnou hru přímo z lokálního serveru, kde funguje automatická lobby i krátké WebRTC kódy.

## WebRTC připojení

1. Hostitel klikne na **Vytvořit nabídku** a pošle vzniklý kód druhému hráči.
2. Druhý hráč vloží kód, klikne na **Přijmout nabídku** a pošle hostiteli vytvořenou odpověď.
3. Hostitel vloží odpověď a klikne na **Přijmout odpověď**.

Při spuštění přes LAN server mají nabídka i odpověď pouze 6 znaků a platí 5 minut. Bez serveru režim stále funguje přes `file://` nebo GitHub Pages, ale kód musí obsahovat celý technický popis spojení, a proto je výrazně delší.
