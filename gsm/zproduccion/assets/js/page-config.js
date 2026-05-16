/**
 * Page kill-switch driven by config.json.
 *
 * Usage (place at the end of <body>):
 *   <script src="assets/js/page-config.js" data-page="index"></script>
 *
 * Looks up `<page>_enablePage` in config.json. When the flag is present and
 * false, the page body is replaced with a maintenance message. If the flag is
 * missing, true, or config.json can't be fetched (e.g. file://), the page
 * stays enabled.
 */
(function () {
    var script = document.currentScript;
    var pageName = script && script.dataset && script.dataset.page;
    if (!pageName) {
        console.warn('page-config.js loaded without data-page attribute; skipping.');
        return;
    }

    function showMaintenance() {
        var doIt = function () {
            document.body.innerHTML =
                '<h4 class="text-center" data-bs-hover-animate="pulse">Página en mantenimiento</h4>';
        };
        if (document.body) doIt();
        else document.addEventListener('DOMContentLoaded', doIt);
    }

    fetch('config.json', { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (cfg) {
            if (!cfg) return;
            var key = pageName + '_enablePage';
            if (key in cfg && cfg[key] === false) showMaintenance();
        })
        .catch(function (e) {
            console.warn('No se pudo cargar config.json, página habilitada por defecto.', e);
        });
})();
