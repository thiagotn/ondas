package ingest

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

// ErrLinkNaoSuportado é o link de um site que sabemos tratar, mas que não é de
// UMA faixa: playlist, canal, perfil, set, busca.
var ErrLinkNaoSuportado = errors.New("este link não é de uma faixa")

// TipoDeLink diz QUEM atende o pedido (ver a migração 0013).
type TipoDeLink string

const (
	// URL direta de mídia: o worker do cluster baixa.
	LinkMidia TipoDeLink = "midia"
	// Página do YouTube ou do SoundCloud: o node do Hermes resolve.
	LinkPagina TipoDeLink = "pagina"
)

var hostsYouTube = map[string]bool{
	"youtube.com": true, "www.youtube.com": true, "m.youtube.com": true,
	"music.youtube.com": true, "youtu.be": true, "www.youtu.be": true,
}

// Primeiros segmentos que são vídeo com a URL em outra forma.
var caminhosDeVideo = map[string]bool{"shorts": true, "live": true, "embed": true, "v": true}

var hostsSoundCloud = map[string]bool{
	"soundcloud.com": true, "www.soundcloud.com": true, "m.soundcloud.com": true,
}

// O encurtador do SoundCloud. Só o node descobre para onde ele aponta.
const hostCurtoSoundCloud = "on.soundcloud.com"

// Segundos segmentos que NÃO são faixa, embora `/<usuário>/<algo>` tenha a
// forma de uma.
var reservadosSoundCloud = map[string]bool{
	"likes": true, "sets": true, "reposts": true, "tracks": true, "albums": true,
	"comments": true, "following": true, "followers": true, "popular-tracks": true,
	"toptracks": true, "stats": true, "insights": true, "groups": true,
}

// O id de vídeo do YouTube: 11 caracteres do alfabeto base64url. Forma, não
// existência — quem diz se o vídeo existe é o node, ao tentar baixar.
var reIDDeVideo = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)

// ClassificarLink diz o que fazer com a URL que a pessoa mandou pela PWA.
//
// Devolve a URL CANONIZADA quando é página: sem rastreador de compartilhamento
// (`si`, `pp`, `index`), sem `list=` e sem o host móvel. É a canônica que vai
// para o banco, e é isso que faz o mesmo vídeo colado de dois jeitos cair no
// mesmo job em vez de baixar duas vezes.
//
// As regras são as das skills do bot (`classificar`, em `ondas-youtube.py` e
// `ondas-soundcloud.py`, no repo homelab), com uma diferença de propósito:
// aqui é UMA faixa por pedido. Playlist e set, que o bot aceita com teto e
// confirmação numa conversa, pela PWA são recusados — não há conversa para
// perguntar "são 40 faixas, tem certeza?".
//
// Qualquer host que não seja um destes é tratado como URL de mídia e segue
// como sempre: quem decide se aquilo é áudio é o worker, com o ffprobe.
func ClassificarLink(bruta string) (string, TipoDeLink, error) {
	u, err := url.Parse(strings.TrimSpace(bruta))
	if err != nil || u.Host == "" {
		return bruta, LinkMidia, nil
	}
	host := strings.ToLower(u.Hostname())
	partes := []string{}
	for _, p := range strings.Split(u.Path, "/") {
		if p != "" {
			partes = append(partes, p)
		}
	}

	switch {
	case hostsYouTube[host]:
		var vid string
		primeiro := ""
		if len(partes) > 0 {
			primeiro = strings.ToLower(partes[0])
		}
		switch {
		case host == "youtu.be" || host == "www.youtu.be":
			if len(partes) > 0 {
				vid = partes[0]
			}
		case caminhosDeVideo[primeiro]:
			if len(partes) > 1 {
				vid = partes[1]
			}
		case primeiro == "watch":
			vid = u.Query().Get("v")
		}
		// Sem vídeo é playlist, canal ou busca. Com vídeo E `list=`, vale o
		// vídeo: é o link que o app do YouTube gera quando algo toca dentro de
		// uma lista, e a pessoa copiou "esta música".
		if !reIDDeVideo.MatchString(vid) {
			return "", "", ErrLinkNaoSuportado
		}
		return "https://www.youtube.com/watch?v=" + vid, LinkPagina, nil

	case hostsSoundCloud[host]:
		if len(partes) != 2 || reservadosSoundCloud[strings.ToLower(partes[1])] {
			return "", "", ErrLinkNaoSuportado
		}
		// Sem query: `?in=usuario/sets/album` faria o scdl pensar em playlist.
		return "https://soundcloud.com/" + partes[0] + "/" + partes[1], LinkPagina, nil

	case host == hostCurtoSoundCloud:
		if len(partes) != 1 {
			return "", "", ErrLinkNaoSuportado
		}
		return "https://" + hostCurtoSoundCloud + "/" + partes[0], LinkPagina, nil
	}
	return bruta, LinkMidia, nil
}
