package httpapi

// As três frases que a prévia de link escreve por conta própria.
//
// A API não tem catálogo de tradução e não vai ter: ela não pode importar nada
// do monorepo (a imagem é construída só com `api/`), e duplicar ~300 chaves
// aqui para usar três seria o pior dos dois mundos. São estas três, e só elas,
// porque o cartão de sucesso — `artista · #genero · M:SS` — não tem palavra
// nenhuma.
//
// O idioma vem do PATH do link (`/en/t/...`), repassado pelo nginx como
// `?lang=`, e não de `Accept-Language`: o robô do WhatsApp não manda esse
// header de forma confiável, e negociar na mesma URL com a Cloudflare na
// frente é envenenamento de cache — o comentário do bloco `/t/` no
// `nginx.conf` já narra essa armadilha com o 302 do robô.
type frasesOG struct {
	Lang      string
	Privada   string
	Invalido  string
	SemPrevia string
}

var frasesPorIdioma = map[string]frasesOG{
	"": {
		Lang:      "pt-BR",
		Privada:   "faixa privada — entre para ouvir.",
		Invalido:  "link de faixa inválido.",
		SemPrevia: "faixa não encontrada — o link pode estar velho.",
	},
	"en": {
		Lang:      "en",
		Privada:   "private track — sign in to listen.",
		Invalido:  "invalid track link.",
		SemPrevia: "track not found — the link may be old.",
	},
	"es": {
		Lang:      "es",
		Privada:   "pista privada — entra para oírla.",
		Invalido:  "enlace de pista inválido.",
		SemPrevia: "pista no encontrada — el enlace puede estar viejo.",
	},
}

// frasesDe escolhe o jogo de frases. Idioma desconhecido cai no português, que
// é o da raiz do site.
func frasesDe(lang string) frasesOG {
	if f, ok := frasesPorIdioma[lang]; ok {
		return f
	}
	return frasesPorIdioma[""]
}
