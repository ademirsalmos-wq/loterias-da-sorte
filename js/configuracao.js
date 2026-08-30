/**
 * configuracao.js — as chaves de acesso ao banco, num lugar só.
 *
 * =====================================================================
 * PREENCHA OS DOIS CAMPOS ABAIXO E PUBLIQUE. É o único arquivo que
 * precisa ser editado à mão para a sincronização funcionar.
 *
 * Onde achar os valores: console do Firebase → engrenagem (⚙) ao lado
 * de "Visão geral do projeto" → Configurações do projeto → aba Geral →
 * role até "Seus aplicativos" → escolha o app da Web → o bloco de
 * configuração mostra `apiKey` e `projectId`.
 *
 * Se ainda não existe um app da Web ali, clique no ícone `</>` para
 * criar um. Não precisa instalar nada do que a tela sugerir — este
 * sistema fala com o Firebase por REST puro, sem SDK.
 * =====================================================================
 *
 * ---------------------------------------------------------------------
 * ESTA CHAVE PODE FICAR VISÍVEL. É assim que o Firebase foi desenhado.
 *
 * A `apiKey` da Web não é uma senha: ela só identifica o projeto. Quem
 * protege os dados são as regras de segurança do Firestore
 * (`firebase/firestore.rules`), que exigem um usuário autenticado e só
 * devolvem os documentos dele. Sem login, a chave sozinha não abre nada.
 *
 * Por isso ela pode ser publicada num repositório público sem problema.
 * O próprio Google diz isso na documentação de chaves de API do Firebase.
 *
 * O QUE NUNCA PODE ENTRAR AQUI: qualquer credencial de servidor — chave
 * de conta de serviço (aquele JSON com `private_key`), token do Admin
 * SDK, ou senha de banco. Essas passam por cima das regras de segurança
 * e dariam acesso total a quem lesse o arquivo.
 * ---------------------------------------------------------------------
 */

export const FIREBASE = {
  /** Configurações do projeto → Geral → Seus aplicativos → app da Web. */
  apiKey: 'AIzaSyDsfL6gwmpplAEiBAdNI6oTIEh9Z8jkUBA',

  /** O ID, não o nome de exibição. Confira em Configurações do projeto → Geral. */
  projectId: 'loterias-da-sorte-1',
};

/**
 * Onde os bilhetes ficam guardados, dentro do Firestore.
 *
 * O caminho é `usuarios/{uid}/bilhetes/{id}`: cada usuário tem a própria
 * subcoleção. Isso não é enfeite de organização — é o que torna a regra
 * de segurança trivial de escrever e impossível de errar, porque a dona
 * do documento está no próprio caminho:
 *
 *     match /usuarios/{uid}/{document=**} {
 *       allow read, write: if request.auth.uid == uid;
 *     }
 *
 * A alternativa (uma coleção única com um campo `userId`) obrigaria a
 * regra a inspecionar o conteúdo de cada documento, o que além de mais
 * frágil quebra a listagem da coleção inteira.
 */
export const COLECAO_BILHETES = 'bilhetes';
export const COLECAO_USUARIOS = 'usuarios';

/** true quando os dois campos foram preenchidos. */
export function nuvemConfigurada() {
  return Boolean(FIREBASE.apiKey && FIREBASE.projectId);
}
