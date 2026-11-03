import pypdf
import re
import json

pdf_path = r"C:\Users\Roberto\.gemini\antigravity\brain\31a46309-95d6-4333-a385-4d4b584c3f53\.user_uploaded\media_1793724459631_f79b5702.pdf"
reader = pypdf.PdfReader(pdf_path)

all_text = ""
for page_num, p in enumerate(reader.pages):
    all_text += f"\n===PAGE_{page_num+1}===\n" + p.extract_text()

# We need to extract each payment record:
# A record starts with a date pattern: \d{2}/\d{2}/\d{2}\s+1\s+\d{2}/\d{2}/\d{2}
# or we can extract by Doc/Sér: (\d{4,6})\s*/\s*(\d+)
pattern = re.compile(
    r'(\d{2}/\d{2}/\d{2})\s+1\s+(\d{2}/\d{2}/\d{2})'  # Vencto, Baixa=1, Pagto
    r'.*?'
    r'FAZENDA[^\n]*-\s*-\s*(\d+)\s*/\s*(\d+)'         # Doc / Série
    r'(.*?)(?=(?:\d{2}/\d{2}/\d{2}\s+1\s+\d{2}/\d{2}/\d{2})|(?:Total faturas baixadas)|$)',
    re.DOTALL
)

print(f"Total pages: {len(reader.pages)}")

# Let's write a robust line-by-line / block parser
# Let's inspect the entire document
records = []
for p_idx, page in enumerate(reader.pages):
    text = page.extract_text()
    
    # Extract faturas at the top of the page if any
    top_faturas = re.findall(r'^(\d{6})\s*/\s*1', text, re.M)
    
    # Look for NF lines:
    # Example: 'FAZENDA (16132) - - 43350 /2' or 'FAZENDA\xa0(16132) - - 43350 /2'
    # Or 'TEX COURIER S.A (32765) - - 0 /'
    
    # Split text into chunks by payment date:
    # matches: (\d{2}/\d{2}/\d{2})\s+1\s+(\d{2}/\d{2}/\d{2})
    matches = list(re.finditer(r'(\d{2}/\d{2}/\d{2})\s+1\s+(\d{2}/\d{2}/\d{2})', text))
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i+1].start() if (i+1 < len(matches)) else len(text)
        block = text[start:end]
        
        vencto = m.group(1)
        pagto = m.group(2)
        
        # Doc / serie
        doc_match = re.search(r'-\s*-\s*(\d+)\s*/\s*(\d*)', block)
        nf = doc_match.group(1) if doc_match else None
        serie = doc_match.group(2) if (doc_match and doc_match.group(2)) else '2'
        
        # UF and Tipo (DARE / GNRE)
        uf = 'ND'
        tipo = 'GNRE'
        uf_match = re.search(r'SEFAZ[- ]([A-Z]{2})/(DARE|GNRE)', block, re.I)
        if uf_match:
            uf = uf_match.group(1).upper()
            tipo = uf_match.group(2).upper()
        else:
            uf_gnre = re.search(r'GNRE[- ]([A-Z]{2})', block, re.I)
            if uf_gnre:
                uf = uf_gnre.group(1).upper()
            else:
                uf_dare = re.search(r'DARE[- ]([A-Z]{2})', block, re.I)
                if uf_dare:
                    uf = uf_dare.group(1).upper()
                    tipo = 'DARE'
                else:
                    if 'SP/DARE' in block:
                        uf = 'SP'
                        tipo = 'DARE'
                    elif 'MG/GNRE' in block:
                        uf = 'MG'
                    elif 'RJ/GNRE' in block:
                        uf = 'RJ'
                    elif 'DF/GNRE' in block:
                        uf = 'DF'
                    elif 'PR/GNRE' in block:
                        uf = 'PR'
                    elif 'SC/GNRE' in block:
                        uf = 'SC'
                    elif 'RS/GNRE' in block:
                        uf = 'RS'
                    elif 'GO/GNRE' in block:
                        uf = 'GO'
                    elif 'BAHIA' in block:
                        uf = 'BA'
        
        # Values: find all R$ numbers in the block
        money_matches = re.findall(r'R\$\s*([\d\.,]+)', block)
        # Typically: valor_fatura, juros, desconto, valor_pago
        val_fatura = 0.0
        val_pago = 0.0
        juros = 0.0
        desc = 0.0
        
        if len(money_matches) >= 4:
            try:
                val_fatura = float(money_matches[0].replace('.', '').replace(',', '.'))
                juros = float(money_matches[1].replace('.', '').replace(',', '.'))
                desc = float(money_matches[2].replace('.', '').replace(',', '.'))
                val_pago = float(money_matches[3].replace('.', '').replace(',', '.'))
            except:
                pass
        elif len(money_matches) >= 1:
            try:
                val_pago = float(money_matches[-1].replace('.', '').replace(',', '.'))
                val_fatura = val_pago
            except:
                pass
                
        # Check if estornado
        estornado = 'estornada' in block.lower() or 'baixa errada' in block.lower()
        
        records.append({
            'page': p_idx + 1,
            'vencto': vencto,
            'pagto': pagto,
            'nf': nf,
            'serie': serie,
            'uf': uf,
            'tipo': tipo,
            'valor_fatura': val_fatura,
            'juros': juros,
            'desconto': desc,
            'valor_pago': val_pago,
            'estornado': estornado,
            'bloco_resumo': block.replace('\n', ' ')[:100]
        })

print(f"Total records extracted: {len(records)}")
total_pago = sum(r['valor_pago'] for r in records if not r['estornado'])
print(f"Total Pago (non-estornado): R$ {total_pago:,.2f}")
total_geral = sum(r['valor_pago'] for r in records)
print(f"Total Pago (geral): R$ {total_geral:,.2f}")

# Sample records
print("\nFirst 5:")
for r in records[:5]:
    print(r)

print("\nLast 5:")
for r in records[-5:]:
    print(r)

# Count by UF
uf_counts = {}
for r in records:
    uf_counts[r['uf']] = uf_counts.get(r['uf'], 0) + 1
print("\nPor UF:", uf_counts)

# Save to JSON
with open('guias_pagas_oficiais_microvix.json', 'w', encoding='utf-8') as f:
    json.dump(records, f, ensure_ascii=False, indent=2)
print("Saved to guias_pagas_oficiais_microvix.json")
