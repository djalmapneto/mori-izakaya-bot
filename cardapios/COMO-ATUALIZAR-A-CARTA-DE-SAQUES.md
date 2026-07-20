# Como atualizar a carta de saquês

A carta de saquês que o Morinho envia é o arquivo **`saques.pdf`**. Ele é gerado a
partir do arquivo-fonte **`saques-fonte.html`** (é ali que ficam os textos e preços).

Quando um preço, descrição ou item mudar, siga estes 4 passos.

## 1) Editar o texto/preço

Abra `cardapios/saques-fonte.html` num editor de texto e mude o que precisar.
Os preços aparecem assim no arquivo (é só trocar o número):

```html
<span class="pval">R$ 89,90</span>
```

## 2) Gerar o PDF novo

No terminal, dentro da pasta do projeto, rode:

```
bash cardapios/gerar-saques-pdf.sh
```

Isso recria o `saques.pdf` com a carta atualizada. Abra pra conferir:

```
open cardapios/saques.pdf
```

## 3) Salvar no GitHub

```
git add cardapios/saques-fonte.html cardapios/saques.pdf
git commit -m "Atualiza carta de saques"
git push
```

## 4) Publicar na VPS (onde o Morinho roda)

```
cd /root/mori-izakaya-bot
git pull
pm2 restart morinho
```

Pronto — a partir daí o Morinho passa a enviar a carta atualizada.

> Dica: se você mudar um preço na carta (aqui), lembre de mudar **também** no
> `restaurante.md`, que é de onde o Morinho tira as respostas em texto. Assim o PDF e
> as respostas escritas ficam sempre iguais.
