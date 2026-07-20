#!/bin/bash
# Gera o PDF da carta de saquês (saques.pdf) a partir de saques-fonte.html.
# Uso:  bash cardapios/gerar-saques-pdf.sh
set -e

# Pasta onde este script está (cardapios/), funcione de onde for chamado.
DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ ! -x "$CHROME" ]; then
  echo "❌ Não achei o Google Chrome em $CHROME"
  echo "   Instale o Chrome ou ajuste o caminho neste script."
  exit 1
fi

"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer \
  --virtual-time-budget=4000 \
  --print-to-pdf="$DIR/saques.pdf" \
  "file://$DIR/saques-fonte.html" 2>/dev/null

echo "✅ PDF gerado: $DIR/saques.pdf"
