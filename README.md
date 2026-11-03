# ili studio · prototype (étape 1)

Importer un site (ZIP ou HTML fait avec ChatGPT, Claude, Lovable…), cliquer sur n'importe quel élément pour le modifier, puis publier.

## Ce que fait cette version

- **Import** d'un `.zip` ou `.html` : détection du dossier du site (`dist/`, `build/`…), chemins `/…` rendus relatifs, fichiers dangereux refusés.
- **Éditeur visuel** : survol et sélection des éléments, texte modifiable sur place (double-clic), images (remplacer, texte alternatif), liens, déplacer, dupliquer, supprimer, sélectionner le parent.
- **Aperçu** ordinateur / tablette / mobile, mode Édition ou Aperçu.
- **Annuler** (50 étapes par page), **Publier** vers `/s/<adresse-du-site>/`.
- **Sécurité** : connexion par mot de passe, le code des sites tourne dans un bac à sable (il ne peut pas lire l'admin), protection contre les archives piégées.

- **Wren (IA)** : sélectionner un élément et demander une modification (réécrire, raccourcir, moderniser une section…). Chaque modification peut être annulée.
- **Style** : couleurs, taille, graisse, alignement, arrondis, espace intérieur.

- **Thèmes** : créer un site à partir d'un thème conçu par un designer ; Wren remplit les textes et la banque d'images ajoute les photos, à partir du brief du client.
- **Admin des thèmes** (`/themes`) : ajouter, mettre à jour ou supprimer un thème en déposant un ZIP.
- **Banque de photos gratuite** (Pixabay) dans l'éditeur, avec suggestions de recherche par Wren ; photos et images téléversées redimensionnées et compressées en WebP.

Pas encore : comptes clients, crédits, domaines personnalisés, paiement, ajout de pages/sections, styles globaux du site.

## Photos (Pixabay)

Créer une clé gratuite sur https://pixabay.com/api/docs/ (connecté, la clé apparaît dans la page), puis dans CapRover :

```
PIXABAY_API_KEY=votre-cle
```

## Format d'un thème

Un thème est un dossier (ou un ZIP de ce dossier) :

```
theme.json        {"id": "artisan-bold", "name": "…", "category": "Trades", "description": "…", "version": "1.0.0",
                   "pages": ["index.html", "contact.html"],
                   "templates": [{"id": "about", "name": "About us", "file": "templates/about.html", "path": "about.html"}]}
index.html …      les pages du thème
assets/           CSS, polices, images, scripts
templates/*.html  modèles de pages ajoutables plus tard (facultatif)
preview.png       capture pour la galerie (facultatif)
```

Dans le HTML, les zones personnalisables sont des **slots** :

| Attribut | Rôle |
|---|---|
| `data-ili-slot="hero.title"` | texte écrit par Wren (`data-ili-hint`, `data-ili-max` l'aident) |
| `data-ili-type="business\|phone\|email\|town\|address"` | fait inséré tel quel depuis le brief, jamais inventé |
| `data-ili-optional` | retiré si le fait est absent (ex. pas d'e-mail) |
| `<img data-ili-slot="hero.image" data-ili-query="electrician at work" data-ili-orientation="horizontal">` | photo choisie dans la banque |

Les thèmes intégrés sont dans `themes/` du dépôt ; ceux ajoutés par l'admin sont stockés dans `/data/themes` (un thème ajouté avec le même `id` remplace l'intégré).

## Activer Wren

Dans CapRover → App Configs → Environmental Variables, ajouter **une** des deux options :

```
# Test gratuit avec Gemini (clé sur aistudio.google.com)
GEMINI_API_KEY=votre-cle
# GEMINI_MODEL=gemini-flash-latest   (facultatif)

# ou Azure (Azure AI Foundry : déployer un modèle, puis copier endpoint + clé)
AZURE_OPENAI_ENDPOINT=https://votre-ressource.openai.azure.com
AZURE_OPENAI_API_KEY=votre-cle
AZURE_OPENAI_DEPLOYMENT=nom-du-deploiement
# AZURE_OPENAI_REASONING_EFFORT=minimal   (facultatif, pour les modèles « reasoning »)

# ou Claude (clé sur console.anthropic.com)
ANTHROPIC_API_KEY=votre-cle
# ANTHROPIC_MODEL=claude-haiku-5-5   (facultatif)
```

Attention : avec l'offre gratuite de Gemini, Google peut utiliser les contenus envoyés pour améliorer ses produits. À réserver aux tests, jamais aux sites de vrais clients.

## Déployer sur CapRover

1. **Create New App** → nom `ili-studio` → cocher **Has Persistent Data** → Create.
2. Onglet **App Configs** :
   - **Persistent Directories** : chemin dans l'app `/data`, étiquette `ili-studio-data`.
   - **Environmental Variables** (mode Bulk Edit) :
     ```
     ADMIN_PASSWORD=un-mot-de-passe-long
     ADMIN_EMAIL=admin            (optionnel : identifiant admin, « admin » par défaut)
     FREE_DOMAIN=yela.uk          (optionnel : domaine des sites gratuits)
     SESSION_SECRET=une-longue-chaine-aleatoire
     ```
   - **Container HTTP Port** : `3000`.
   - Sans nom de domaine : **Port Mapping** `8080` (serveur) → `3000` (conteneur), puis ouvrir `http://IP-DU-SERVEUR:8080`.
   - Save & Update.
3. Onglet **Deployment** → *Method 3: Deploy from Github* :
   - Repository : `github.com/FatahHimene/ili-studio`, Branch : `main`
   - Username : votre identifiant GitHub, Password : un **token GitHub** (Settings → Developer settings → Fine-grained token, accès *Contents: Read-only* à ce dépôt uniquement)
   - Save & Update, puis **Force Build**.
4. Mise à jour automatique : copier l'URL du webhook affichée par CapRover dans GitHub → dépôt → Settings → Webhooks → Add webhook (Content type `application/json`).

## Développement local

```
npm install
ADMIN_PASSWORD=test npm run dev   # http://localhost:3000
```

Les données sont dans `./data` (ou `DATA_DIR`).


## Comptes clients et offres

- Les clients créent leur compte sur `/signup` (e-mail + mot de passe, hachés en scrypt dans `DATA_DIR/users`).
- L'admin se connecte avec `ADMIN_EMAIL` (par défaut `admin`) et `ADMIN_PASSWORD`. Lui seul voit l'admin des thèmes et tous les sites.
- Après l'inscription, l'écran `/welcome` présente les offres (Free, Essential, Plus, Pro, définies dans `src/plans.js`).
  Le paiement n'est pas encore branché : un choix payant est enregistré (`wantsPlan`) et le client continue en gratuit.
- Crédits IA : 30 à l'inscription (Free). Wren coûte 1 crédit (texte) ou 2 (bloc). La première création d'un site et la recherche de photos sont gratuites.
  À 0 crédit, l'éditeur propose « Continuer manuellement » ou les offres.
- Publication : le client choisit son adresse `nom.yela.uk`. En Free, seule la page d'accueil est publiée (les liens vers les autres pages
  sont retirés), avec un petit lien « Website made with ili studio by Ilidweb » en bas.
- Les sites gratuits sont servis directement selon le nom d'hôte `*.FREE_DOMAIN` (DNS : `*` et `@` vers l'IP du serveur).
