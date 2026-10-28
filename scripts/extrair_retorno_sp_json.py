import sys
import os
import re
import json
import zipfile
import tempfile
import fitz # PyMuPDF

def extrair_dados_pdf(filepath):
    try:
        doc = fitz.open(filepath)
    except Exception as e:
        return None
    
    text = ""
    for page in doc:
        text += page.get_text() + "\n"
    
    # 1. Linha Digitavel: padrao 85810000000-5 19170185112-0 60590234520-5 69020261026-1
    ld_match = re.search(r"(\d{11}-\d\s+\d{11}-\d\s+\d{11}-\d\s+\d{11}-\d)", text)
    linha_digitavel = ld_match.group(1).strip() if ld_match else None
    
    # 2. Codigo de Barras de 44 digitos a partir da linha digitavel de 48 digitos
    codigo_barras = None
    if linha_digitavel:
        clean_ld = re.sub(r"[^\d]", "", linha_digitavel)
        if len(clean_ld) == 48:
            b1 = clean_ld[0:11]
            b2 = clean_ld[12:23]
            b3 = clean_ld[24:35]
            b4 = clean_ld[36:47]
            codigo_barras = b1 + b2 + b3 + b4
            
    # 3. Numero do DARE
    dare_match = re.search(r"(?:09\s*-\s*)?N[ºu\?o]?mero do DARE\s*[:\n\r]*\s*(\d{10,20})", text, re.IGNORECASE)
    numero_dare = dare_match.group(1) if dare_match else None
    
    # 4. Nota Fiscal
    nf_match = re.search(r"NOTA FISCAL:\s*(\d+)", text, re.IGNORECASE)
    if not nf_match:
        nf_match = re.search(r"N[ºu\?o]?mero da Nota\s*Fiscal\s*[:\n\r]*\s*(\d+)", text, re.IGNORECASE)
    nota_fiscal = nf_match.group(1) if nf_match else None
    
    # 5. Chave de Acesso NF-e (44 digitos)
    chave_match = re.search(r"Campo Extra:\s*[:\n\r]*\s*(\d{44})", text, re.IGNORECASE)
    if not chave_match:
        chave_match = re.search(r"(\d{44})", text)
    chave_nfe = chave_match.group(1) if chave_match else None
    
    # 6. Data de Vencimento
    venc_match = re.search(r"(?:07\s*-\s*)?Data de Vencimento\s*[:\n\r]*\s*(\d{2}/\d{2}/\d{4})", text, re.IGNORECASE)
    data_vencimento = venc_match.group(1) if venc_match else None
    
    # 7. Valor Total
    valor_match = re.search(r"(?:08\s*-\s*)?Valor Total(?:\s*do Documento)?\s*[:\n\r]*\s*(?:R\$\s*)?([\d\.,]+)", text, re.IGNORECASE)
    valor_str = valor_match.group(1).replace(".", "").replace(",", ".") if valor_match else None
    valor_num = float(valor_str) if valor_str else None

    if not (codigo_barras or linha_digitavel):
        return None

    return {
        "arquivo": os.path.basename(filepath),
        "linha_digitavel": linha_digitavel,
        "codigo_barras": codigo_barras,
        "numero_dare": numero_dare,
        "nota_fiscal": nota_fiscal,
        "chave_nfe": chave_nfe,
        "data_vencimento": data_vencimento,
        "valor": valor_num
    }

def processar_alvo(alvo_path):
    temp_dir = None
    pdf_files = []
    
    if zipfile.is_zipfile(alvo_path):
        temp_dir = tempfile.mkdtemp(prefix="expedi_sp_ret_")
        with zipfile.ZipFile(alvo_path, 'r') as zf:
            zf.extractall(temp_dir)
        for root, _, files in os.walk(temp_dir):
            for f in files:
                if f.lower().endswith(".pdf"):
                    pdf_files.append(os.path.join(root, f))
    elif os.path.isdir(alvo_path):
        for root, _, files in os.walk(alvo_path):
            for f in files:
                if f.lower().endswith(".pdf"):
                    pdf_files.append(os.path.join(root, f))
    elif alvo_path.lower().endswith(".pdf"):
        pdf_files.append(alvo_path)
    else:
        print(json.dumps({"error": f"Formato inválido: {alvo_path}"}))
        return

    itens = []
    for p in sorted(pdf_files):
        res = extrair_dados_pdf(p)
        if res:
            itens.append(res)

    # Limpeza se tiver temp_dir
    if temp_dir and os.path.exists(temp_dir):
        import shutil
        try:
            shutil.rmtree(temp_dir)
        except Exception:
            pass

    print(json.dumps({
        "success": True,
        "total_encontrados": len(pdf_files),
        "total_processados": len(itens),
        "itens": itens
    }, ensure_ascii=False))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: python extrair_retorno_sp_json.py <caminho_zip_ou_pasta>"}))
        sys.exit(1)
    processar_alvo(sys.argv[1])
