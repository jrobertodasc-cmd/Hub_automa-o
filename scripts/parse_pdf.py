import pypdf
import re
import json
import sys

PDF_PATH = r"C:\Users\Roberto\Desktop\Web_Services\GNRE\GNRE PENDENTES.pdf"

def parse():
    reader = pypdf.PdfReader(PDF_PATH)
    full_text = '\n'.join([p.extract_text() for p in reader.pages])

    pattern = re.compile(
        r'(\d{2}/\d{2}/\d{4})\s+(\d+)\s*/\s*(\d+)\s+(\d+)/(\d+)\s+(\d+/\d+)\s+(\d{2}/\d{2}/\d{4})\s+R\$\s*([\d\.,]+)\s+([^\n]+)',
        re.MULTILINE
    )
    matches = pattern.findall(full_text)
    items = []
    for m in matches:
        dt_emissao, fatura, emp, nf, serie, parcela, dt_venc, val_str, fornecedor = m
        val_clean = float(val_str.replace('.', '').replace(',', '.'))
        items.append({
            'dt_emissao': dt_emissao,
            'fatura': fatura,
            'emp': emp,
            'nf': nf,
            'serie': serie,
            'parcela': parcela,
            'dt_venc': dt_venc,
            'valor': val_clean,
            'fornecedor': fornecedor.strip()
        })
    print(json.dumps(items))

if __name__ == '__main__':
    parse()
