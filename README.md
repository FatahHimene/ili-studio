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

Pas encore : comptes clients, crédits, domaines personnalisés, paiement.

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
