# Annuaire de démonstration Contoso

Petit serveur LDAP en mémoire qui se comporte comme un Active Directory (entreprise fictive **Contoso**). Il permet
d'essayer la connexion LDAP / Active Directory de Wolflog sans contrôleur de domaine. Les tests automatisés
(`tests/Wolflog.Tests/LdapTests.cs`) l'utilisent aussi, avec le vrai client LDAP de Wolflog.

> **Démonstration uniquement.** Pas de chiffrement (`ldap://` en clair). Le serveur n'écoute que sur 127.0.0.1, garde
> ses données en mémoire (perdues à l'arrêt) et refuse toute écriture. Les mots de passe ci-dessous sont fictifs et
> ne servent qu'ici.

## Lancer l'annuaire

Depuis la racine du dépôt :

```powershell
dotnet run --project samples/Wolflog.DemoDirectory
```

L'annuaire répond sur `ldap://127.0.0.1:10389` jusqu'à Ctrl+C. Pour choisir un autre port :
`dotnet run --project samples/Wolflog.DemoDirectory -- --port 10390`.

La console affiche chaque liaison et chaque recherche (jamais les mots de passe), ce qui permet de suivre ce que fait
Wolflog.

## Comptes

| Identifiant | Nom | Mot de passe | Groupe | Particularité |
|---|---|---|---|---|
| `jdupont` | Jeanne Dupont | `Dupont-2026!` | Wolflog-Admins | |
| `pmartin` | Paul Martin | `Martin-2026!` | Wolflog-Dev | |
| `sbernard` | Sophie Bernard | `Bernard-2026!` | Equipe-Web | Equipe-Web est membre de Wolflog-Produit (groupe imbriqué). |
| `lpetit` | Luc Petit | `Petit-2026!` | Wolflog-Exploitation | |
| `lmoreau` | Léa Moreau | `Moreau-2026!` | Wolflog-Dev | Doit changer son mot de passe (`pwdLastSet` = 0). |
| `mdurand` | Marc Durand | `Durand-2026!` | Wolflog-Dev | Compte désactivé (`userAccountControl` = 514). |

Chaque personne peut se connecter de trois façons : `jdupont`, `jdupont@contoso.local` ou `CONTOSO\jdupont`. Son
e-mail est `jdupont@contoso.fr`.

Le compte de service, en lecture seule, est `CN=svc-wolflog,OU=Comptes de service,DC=contoso,DC=local`. Son mot de
passe est `Lecture-Annuaire-2026`.

## Réglages à saisir dans Wolflog

Ouvrez **Administration › Connexion SSO**. Il faut un compte administrateur Wolflog, et l'authentification doit être
activée.

### Étape 3, « Annuaire LDAP / Active Directory »

| Champ | Valeur |
|---|---|
| Activer | coché |
| Type | **Active Directory** |
| Serveurs | `127.0.0.1` |
| Port | `10389` |
| Nom de l'annuaire | `Contoso` |
| Chiffrement | **Aucun** (l'avertissement est normal : annuaire de démonstration) |
| DN de base | `DC=contoso,DC=local`, ou le bouton « Lire depuis l'annuaire » |
| Compte de service | `CN=svc-wolflog,OU=Comptes de service,DC=contoso,DC=local` |
| Mot de passe du compte de service | `Lecture-Annuaire-2026` |
| Suffixe UPN | `contoso.local` |
| Filtre de recherche et attributs | valeurs proposées pour Active Directory, sans rien changer |
| Groupes imbriqués | coché |

Cliquez ensuite sur « Tester la connexion » : chaque étape doit être validée. Le test de compte (par exemple `sbernard`
et `Bernard-2026!`) montre le DN, l'e-mail, les groupes et ce que Wolflog donnerait, sans créer le compte.

**Variante sans compte de service :** laissez « Compte de service » vide et gardez le suffixe UPN `contoso.local`.
Wolflog se lie alors directement avec `jdupont@contoso.local`, puis lit la propre fiche de la personne.

### Étape 4, comptes

Rôle par défaut : **Lecteur**. Profil d'accès par défaut : **Tout voir**.

### Étape 5, groupes de l'annuaire

Le nom court du groupe suffit. Le DN complet fonctionne aussi, par exemple
`CN=Wolflog-Produit,OU=Groupes,DC=contoso,DC=local`.

| Groupe | Rôle | Profil d'accès |
|---|---|---|
| `Wolflog-Admins` | Administrateur | Profil inchangé |
| `Wolflog-Dev` | Éditeur | Tout voir |
| `Wolflog-Exploitation` | Éditeur | Exploitation |
| `Wolflog-Produit` | Rôle inchangé | Produit |

Cliquez sur **Enregistrer**. La page de connexion indique alors « Identifiant », avec l'exemple
`ex. jdupont ou jdupont@contoso.local  ou votre compte Wolflog`.

## Résultat attendu

| Connexion | Résultat |
|---|---|
| `jdupont` | Administrateur. |
| `pmartin` | Éditeur, profil Tout voir. |
| `sbernard` | Lecteur, profil Produit, par le groupe imbriqué Equipe-Web. |
| `lpetit` | Éditeur, profil Exploitation. |
| `lmoreau` | Refusé : « Votre mot de passe a expiré ou doit être changé… ». |
| `mdurand` | Refusé : « Identifiant ou mot de passe incorrect. » (le message ne révèle rien du compte). |
| Mot de passe vide ou faux | Refusé : « Identifiant ou mot de passe incorrect. ». |

Les comptes créés portent l'identifiant de l'annuaire (`jdupont@contoso.local`) et la source « Annuaire » dans
Administration › Utilisateurs. Leur mot de passe reste géré par l'annuaire. Le compte local `admin` se connecte
toujours avec son mot de passe Wolflog : c'est l'accès de secours.

## Ce que l'annuaire imite

Le serveur reproduit les comportements d'Active Directory que Wolflog doit savoir gérer :

- **Entrée racine (RootDSE) lisible sans liaison** : `defaultNamingContext`, `namingContexts` et `dnsHostName`.
- **Liaison par DN, UPN ou `DOMAINE\compte`**, avec les erreurs d'AD :
  `80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 52e, v4563`. Les codes `data`
  possibles sont :
  - `52e` : identifiants refusés, compte inconnu compris ;
  - `533` : compte désactivé ;
  - `773` : mot de passe à changer ;
  - `775` : compte verrouillé.
- **Liaison avec un mot de passe vide acceptée en anonyme**, comme AD. Wolflog refuse donc un mot de passe vide avant
  d'interroger l'annuaire.
- **Recherche refusée sans liaison** (`000004DC … a successful bind must be completed`), sauf pour l'entrée racine.
- **Références de continuation** (`ldap://ForestDnsZones.contoso.local/…`) lors d'une recherche depuis la racine, comme
  un vrai domaine. Wolflog ne les suit pas.
- **Filtres** : égalité, présence, sous-chaînes, `&`, `|` et `!`. Les règles `LDAP_MATCHING_RULE_IN_CHAIN`
  (`1.2.840.113556.1.4.1941`, groupes imbriqués) et `LDAP_MATCHING_RULE_BIT_AND`/`OR` (`.803`/`.804`,
  `userAccountControl`) sont reconnues, ainsi que `objectCategory=person`.
- **`memberOf` calculé** à partir des `member` des groupes ; limite de taille des résultats respectée.

Il ne gère ni le chiffrement (pas de LDAPS ni de StartTLS), ni les écritures, ni la pagination des résultats.
